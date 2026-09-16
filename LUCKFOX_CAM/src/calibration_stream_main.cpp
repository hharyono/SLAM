#include <atomic>
#include <csignal>
#include <iostream>
#include <string>
#include "streaming_pipeline.hpp"

static std::atomic<bool> running{true};
static void stop(int){running=false;}

int main(int argc,char**argv){
  int width=1280,height=720,fps=10,bitrate=1500,port=8554;
  std::string path="/cal",iq="/etc/iqfiles";
  for(int i=1;i<argc;i++){
    std::string arg=argv[i];
    auto next=[&](){if(i+1>=argc)throw std::runtime_error("missing value for "+arg);return std::string(argv[++i]);};
    if(arg=="--width")width=std::stoi(next());
    else if(arg=="--height")height=std::stoi(next());
    else if(arg=="--fps")fps=std::stoi(next());
    else if(arg=="--bitrate")bitrate=std::stoi(next());
    else if(arg=="--port")port=std::stoi(next());
    else if(arg=="--path")path=next();
    else if(arg=="--iq-dir")iq=next();
    else {std::cerr<<"Usage: luckfox_cam_call [--width 1280] [--height 720] [--fps 10] [--bitrate 1500] [--port 8554] [--path /cal]\n";return 2;}
  }
  if(width<320||height<240||fps<1||fps>30)return 2;
  signal(SIGINT,stop);signal(SIGTERM,stop);signal(SIGPIPE,SIG_IGN);
  try{
    StreamingPipeline camera(width,height,fps,bitrate,8,port,path,iq,1);
    StreamingPipeline::Frame frame;
    std::cerr<<"Calibration stream: rtsp://0.0.0.0:"<<port<<path<<" "<<width<<"x"<<height<<" @ "<<fps<<" fps\n";
    while(running){if(!camera.acquire(frame,500))continue;if(!camera.publish(frame))std::cerr<<"VENC dropped frame\n";}
    camera.release(frame);
  }catch(const std::exception&e){std::cerr<<"luckfox_cam_call: "<<e.what()<<"\n";return 1;}
  return 0;
}
