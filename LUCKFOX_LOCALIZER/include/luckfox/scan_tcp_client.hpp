#pragma once

#include "luckfox/uart_localizer.hpp"

#include <cstdint>
#include <memory>
#include <string>

namespace luckfox {

struct ScanTcpConfig {
  std::string host;
  std::uint16_t port = 42010;
};

// Keeps only the newest scan and streams it on a dedicated TCP connection.
// Network stalls never block UART acquisition/localization.
class ScanTcpClient {
 public:
  explicit ScanTcpClient(ScanTcpConfig config);
  ~ScanTcpClient();
  ScanTcpClient(const ScanTcpClient&) = delete;
  ScanTcpClient& operator=(const ScanTcpClient&) = delete;
  void Start();
  void Stop() noexcept;
  void UpdateScan(const CapturedScan& scan);

 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};

}  // namespace luckfox
