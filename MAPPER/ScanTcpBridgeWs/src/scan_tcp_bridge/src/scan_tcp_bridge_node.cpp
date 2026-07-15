#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/laser_scan.hpp>
#include <nav_msgs/msg/occupancy_grid.hpp>

#include <arpa/inet.h>
#include <atomic>
#include <cmath>
#include <cstring>
#include <limits>
#include <netinet/in.h>
#include <sys/socket.h>
#include <thread>
#include <unistd.h>
#include <vector>

namespace {
constexpr std::uint32_t kMagic = 0x53434e31;  // SCN1
constexpr std::size_t kHeaderBytes = 16;
constexpr std::size_t kMetadataBytes = 40;
constexpr std::uint32_t kMaximumPayload = 1024 * 1024;
constexpr std::uint32_t kMapMagic = 0x4d415031;  // MAP1

std::uint16_t Get16(const std::uint8_t* data) {
  std::uint16_t value; std::memcpy(&value, data, sizeof(value)); return ntohs(value);
}
std::uint32_t Get32(const std::uint8_t* data) {
  std::uint32_t value; std::memcpy(&value, data, sizeof(value)); return ntohl(value);
}
float GetFloat(const std::uint8_t* data) {
  const std::uint32_t bits = Get32(data); float value; std::memcpy(&value, &bits, sizeof(value)); return value;
}
void Put32(std::vector<std::uint8_t>* output, std::uint32_t value) {
  value = htonl(value); const auto* bytes = reinterpret_cast<const std::uint8_t*>(&value);
  output->insert(output->end(), bytes, bytes + 4);
}
void PutFloat(std::vector<std::uint8_t>* output, float value) {
  std::uint32_t bits; std::memcpy(&bits, &value, sizeof(bits)); Put32(output, bits);
}
bool SendAll(int fd, const std::vector<std::uint8_t>& data) {
  std::size_t offset = 0;
  while (offset < data.size()) {
    const auto sent = send(fd, data.data() + offset, data.size() - offset, MSG_NOSIGNAL);
    if (sent <= 0) return false;
    offset += static_cast<std::size_t>(sent);
  }
  return true;
}
}  // namespace

class ScanTcpBridge : public rclcpp::Node {
 public:
  ScanTcpBridge() : Node("scan_tcp_bridge") {
    port_ = declare_parameter<int>("port", 42010);
    frame_id_ = declare_parameter<std::string>("frame_id", "laser_frame");
    map_backend_host_ = declare_parameter<std::string>("map_backend_host", "127.0.0.1");
    map_backend_port_ = declare_parameter<int>("map_backend_port", 42020);
    // RF2O subscribes with reliable QoS, matching the original YDLidar ROS driver.
    publisher_ = create_publisher<sensor_msgs::msg::LaserScan>("/scan", rclcpp::QoS(10).reliable());
    map_subscription_ = create_subscription<nav_msgs::msg::OccupancyGrid>(
      "/map", rclcpp::QoS(1).transient_local().reliable(),
      [this](const nav_msgs::msg::OccupancyGrid::SharedPtr map) { SendMap(*map); });
    worker_ = std::thread([this] { Serve(); });
  }

  ~ScanTcpBridge() override {
    running_ = false;
    if (server_fd_ >= 0) shutdown(server_fd_, SHUT_RDWR);
    if (client_fd_ >= 0) shutdown(client_fd_, SHUT_RDWR);
    if (worker_.joinable()) worker_.join();
    if (client_fd_ >= 0) close(client_fd_);
    if (server_fd_ >= 0) close(server_fd_);
  }

 private:
  void Serve() {
    server_fd_ = socket(AF_INET, SOCK_STREAM, 0);
    int reuse = 1; setsockopt(server_fd_, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    sockaddr_in address{}; address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_ANY);
    address.sin_port = htons(static_cast<std::uint16_t>(port_));
    if (server_fd_ < 0 || bind(server_fd_, reinterpret_cast<sockaddr*>(&address), sizeof(address)) < 0 ||
        listen(server_fd_, 2) < 0) {
      RCLCPP_FATAL(get_logger(), "Cannot listen on TCP port %d", port_); return;
    }
    RCLCPP_INFO(get_logger(), "Waiting for Luckfox ScanFrame on TCP %d", port_);
    while (running_ && rclcpp::ok()) {
      client_fd_ = accept(server_fd_, nullptr, nullptr);
      if (client_fd_ < 0) continue;
      RCLCPP_INFO(get_logger(), "Luckfox scan stream connected");
      std::vector<std::uint8_t> incoming;
      std::uint8_t chunk[8192];
      while (running_ && rclcpp::ok()) {
        const auto received = recv(client_fd_, chunk, sizeof(chunk), 0);
        if (received <= 0) break;
        incoming.insert(incoming.end(), chunk, chunk + received);
        Parse(&incoming);
      }
      close(client_fd_); client_fd_ = -1;
      RCLCPP_WARN(get_logger(), "Luckfox scan stream disconnected");
    }
  }

  void Parse(std::vector<std::uint8_t>* incoming) {
    while (incoming->size() >= kHeaderBytes) {
      const auto* data = incoming->data();
      if (Get32(data) != kMagic || Get16(data + 4) != 1) {
        incoming->erase(incoming->begin()); continue;
      }
      const auto payload_size = Get32(data + 8);
      if (payload_size > kMaximumPayload) { incoming->clear(); return; }
      if (incoming->size() < kHeaderBytes + payload_size) return;
      if (Get16(data + 6) == 1) Publish(data + kHeaderBytes, payload_size);
      incoming->erase(incoming->begin(), incoming->begin() + kHeaderBytes + payload_size);
    }
  }

  void Publish(const std::uint8_t* payload, std::uint32_t payload_size) {
    if (payload_size < kMetadataBytes) return;
    sensor_msgs::msg::LaserScan message;
    message.header.stamp = now();
    message.header.frame_id = frame_id_;
    message.angle_min = GetFloat(payload + 8);
    message.angle_max = GetFloat(payload + 12);
    message.angle_increment = GetFloat(payload + 16);
    message.time_increment = GetFloat(payload + 20);
    message.scan_time = GetFloat(payload + 24);
    message.range_min = GetFloat(payload + 28);
    message.range_max = GetFloat(payload + 32);
    const auto point_count = Get32(payload + 36);
    if (payload_size != kMetadataBytes + point_count * 12 || message.angle_increment <= 0.0F) return;
    const auto bin_count = static_cast<std::size_t>(
      std::lround((message.angle_max - message.angle_min) / message.angle_increment)) + 1;
    if (bin_count < 2 || bin_count > 10000) return;
    message.ranges.assign(bin_count, std::numeric_limits<float>::infinity());
    message.intensities.assign(bin_count, 0.0F);
    for (std::uint32_t index = 0; index < point_count; ++index) {
      const auto* point = payload + kMetadataBytes + index * 12;
      const float angle = GetFloat(point), range = GetFloat(point + 4);
      const auto bin = static_cast<long>(std::lround((angle - message.angle_min) / message.angle_increment));
      if (bin >= 0 && static_cast<std::size_t>(bin) < bin_count &&
          std::isfinite(range) && range >= message.range_min && range <= message.range_max) {
        message.ranges[static_cast<std::size_t>(bin)] = range;
        message.intensities[static_cast<std::size_t>(bin)] = GetFloat(point + 8);
      }
    }
    publisher_->publish(message);
  }

  void SendMap(const nav_msgs::msg::OccupancyGrid& map) {
    const auto payload_size = static_cast<std::uint32_t>(24 + map.data.size());
    std::vector<std::uint8_t> frame; frame.reserve(16 + payload_size);
    Put32(&frame, kMapMagic); Put32(&frame, 1); Put32(&frame, payload_size); Put32(&frame, map_sequence_++);
    Put32(&frame, map.info.width); Put32(&frame, map.info.height); PutFloat(&frame, map.info.resolution);
    PutFloat(&frame, static_cast<float>(map.info.origin.position.x));
    PutFloat(&frame, static_cast<float>(map.info.origin.position.y));
    const auto& q = map.info.origin.orientation;
    const float yaw = static_cast<float>(std::atan2(2.0 * (q.w * q.z + q.x * q.y),
                                                     1.0 - 2.0 * (q.y * q.y + q.z * q.z)));
    PutFloat(&frame, yaw);
    frame.insert(frame.end(), reinterpret_cast<const std::uint8_t*>(map.data.data()),
                 reinterpret_cast<const std::uint8_t*>(map.data.data()) + map.data.size());
    const int fd = socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in address{}; address.sin_family = AF_INET; address.sin_port = htons(map_backend_port_);
    if (fd >= 0 && inet_pton(AF_INET, map_backend_host_.c_str(), &address.sin_addr) == 1 &&
        connect(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0) SendAll(fd, frame);
    if (fd >= 0) close(fd);
  }

  int port_ = 42010, server_fd_ = -1, client_fd_ = -1;
  std::string frame_id_;
  std::string map_backend_host_;
  int map_backend_port_ = 42020;
  std::uint32_t map_sequence_ = 0;
  std::atomic<bool> running_{true};
  std::thread worker_;
  rclcpp::Publisher<sensor_msgs::msg::LaserScan>::SharedPtr publisher_;
  rclcpp::Subscription<nav_msgs::msg::OccupancyGrid>::SharedPtr map_subscription_;
};

int main(int argc, char** argv) {
  rclcpp::init(argc, argv);
  rclcpp::spin(std::make_shared<ScanTcpBridge>());
  rclcpp::shutdown();
  return 0;
}
