#include "luckfox/mavlink_output.hpp"
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>

void Check(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
float ReadFloat(const std::vector<std::uint8_t>& packet, unsigned at) {
  std::uint32_t v = 0;
  for (unsigned i=0; i<4; ++i) v |= std::uint32_t(packet[at+i]) << (8*i);
  float f;
  std::memcpy(&f, &v, 4);
  return f;
}
int main(int argc, char** argv) try {
  Check(argc == 2, "fixture path required");
  luckfox::MavlinkConfig cfg;
  std::ifstream fixture(argv[1]);
  std::string hex; fixture >> hex;
  std::vector<std::uint8_t> expected;
  for (std::size_t i=0; i<hex.size(); i+=2)
    expected.push_back(std::stoul(hex.substr(i,2), nullptr, 16));
  const auto frame = luckfox::EncodeVisionPosition(cfg, {2,3,0},123456789,42,7);
  Check(!expected.empty() && frame == expected, "pymavlink wire fixture mismatch");
  cfg.map_heading_rad = 1.57079632679F; cfg.origin_x = 10; cfg.origin_y = 20;
  auto rotated = luckfox::EncodeVisionPosition(cfg,{12,23,0},1,255,0);
  Check(std::abs(ReadFloat(rotated,18)-3)<1e-5 &&
        std::abs(ReadFloat(rotated,22)-2)<1e-5, "map to NED rotation/origin");
  Check(std::abs(ReadFloat(rotated,38)-cfg.map_heading_rad)<1e-5, "yaw rotation");
  Check(rotated.size()<129 && std::isnan(ReadFloat(rotated,42)), "v2 truncation/covariance");
  bool rejected=false;
  try { cfg.system_id=256; luckfox::EncodeVisionPosition(cfg,{},1,0,0); }
  catch (const std::invalid_argument&) { rejected=true; }
  Check(rejected,"invalid system ID accepted");
  cfg = {};
  const int master = ::posix_openpt(O_RDWR | O_NOCTTY | O_NONBLOCK);
  Check(master>=0 && ::grantpt(master)==0 && ::unlockpt(master)==0,"PTY creation");
  cfg.port = ::ptsname(master);
  luckfox::MavlinkOutput output(cfg);
  luckfox::LocalizationResult r;
  r.valid=true; r.state=luckfox::LocalizationState::Tracking; r.pose={2,3,0};
  Check(output.Send(r,1000000,1000100),"valid tracking not sent");
  auto receive = [&]() {
    pollfd pfd{master,POLLIN,0};
    Check(::poll(&pfd,1,1000)>0,"UART packet missing");
    std::vector<std::uint8_t> b(256);
    auto n=::read(master,b.data(),b.size()); Check(n>0,"UART read failed");
    b.resize(n); return b;
  };
  Check(receive()==luckfox::EncodeVisionPosition(cfg,r.pose,1000000,0,0),"UART bytes differ");
  Check(!output.Send(r,1000000,1000100),"duplicate timestamp sent");
  Check(!output.Send(r,1000001,1500000),"stale pose sent");
  Check(!output.Send(r,2000000,1500000),"future pose sent");
  r.valid=false; Check(!output.Send(r,1000010,1000020),"invalid pose sent");
  r.valid=true; r.state=luckfox::LocalizationState::Recovered;
  Check(!output.Send(r,1000030,1000040),"unconfirmed recovery sent");
  r.state=luckfox::LocalizationState::Tracking;
  Check(output.Send(r,1000050,1000060),"confirmed recovery not sent");
  Check(receive()==luckfox::EncodeVisionPosition(cfg,r.pose,1000050,1,1),"reset counter missing");
  r.pose.x=std::numeric_limits<float>::quiet_NaN();
  Check(!output.Send(r,1000070,1000080),"NaN pose sent");
  r.pose.x=2; output.Reset();
  Check(output.Send(r,1000090,1000100),"restart pose missing");
  Check(receive()==luckfox::EncodeVisionPosition(cfg,r.pose,1000090,2,2),"restart reset missing");
  ::close(master);
  rejected=false;
  try { output.Send(r,1000110,1000120); } catch (const std::runtime_error&) { rejected=true; }
  Check(rejected,"serial disconnect not reported");
  std::cout << "MAVLink wire, coordinates, gating, reset and serial tests passed\n";
  return 0;
} catch (const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
