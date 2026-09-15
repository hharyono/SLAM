#pragma once
#include <cstdint>
#include <string>

extern "C" {
#include "sample_comm.h"
#include "rtsp_demo.h"
}

class StreamingPipeline {
 public:
  struct Frame { VIDEO_FRAME_INFO_S info{}; uint8_t* y=nullptr; bool held=false; };
  StreamingPipeline(int width,int height,int fps,int bitrate,int gop,int port,
                    const std::string& path,const std::string& iq_dir,int rtsp_mode);
  ~StreamingPipeline();
  bool acquire(Frame& frame,int timeout_ms);
  void release(Frame& frame);
  bool publish(Frame& frame,int timeout_ms=100);
 private:
  static void* streamEntry(void* arg);
  void streamLoop();
  void cleanup();
  int width_,height_;
  bool isp_=false,sys_=false,vi_ok_=false,venc_ok_=false,bound_=false;
  bool transmit_=true;
  volatile bool streaming_=true;
  SAMPLE_VI_CTX_S vi_{};
  SAMPLE_VENC_CTX_S venc_{};
  MPP_CHN_S source_{},destination_{};
  rtsp_demo_handle rtsp_=nullptr;
  rtsp_session_handle session_=nullptr;
};
