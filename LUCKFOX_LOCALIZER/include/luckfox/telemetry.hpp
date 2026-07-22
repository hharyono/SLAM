#pragma once

#include "luckfox/uart_localizer.hpp"

#include <cstdint>
#include <fstream>
#include <string>

namespace luckfox {

// Append-only structured logging for publication experiments. Empty paths
// disable the corresponding output. Experiment tooling creates unique paths,
// so raw evidence is never silently overwritten.
class TelemetryLogger {
 public:
  TelemetryLogger(std::string telemetry_path, std::string raw_scan_path,
                  std::string experiment_id, std::string experiment_condition,
                  std::string experiment_run_type, std::string experiment_route_id);

  void LogConfiguration(const UartLidarConfig& lidar,
                        const SearchOptions& search,
                        const StateOptions& state);
  void Log(std::uint64_t sequence, const CapturedScan& scan,
           const LocalizationResult& result, std::uint64_t scan_cycle_us);
  void LogResource(const char* operating_state);

 private:
  std::ofstream telemetry_;
  std::ofstream raw_scan_;
  std::string experiment_id_;
  std::string experiment_condition_;
  std::string experiment_run_type_;
  std::string experiment_route_id_;
  std::uint64_t previous_cpu_us_ = 0;
  std::uint64_t previous_wall_us_ = 0;
};

}  // namespace luckfox
