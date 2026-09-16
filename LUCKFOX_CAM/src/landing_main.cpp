#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <thread>
#include <vector>
#include <arpa/inet.h>
#include <fcntl.h>
#include <linux/videodev2.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <termios.h>
#include <unistd.h>
#include "streaming_pipeline.hpp"
extern "C" {
#include "apriltag.h"
#include "apriltag_pose.h"
#include "tag36h11.h"
}

static std::atomic<bool> run{true};
static void sig(int){run=false;}
static uint64_t usec(){return std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();}

struct Cfg {std::string dev="/dev/video11",uart="/dev/ttyS5",host="127.0.0.1";int baud=115200,bridge_port=5761,w=1280,h=720,id=0,ham=0,lost=300,hz=10,threads=2;double size=.2,ox=0,oy=0,oz=0,maxerr=2,margin=35,decimate=1.5;};
static std::string trim(std::string s){auto a=s.find_first_not_of(" \t");auto b=s.find_last_not_of(" \t\r");return a==std::string::npos?"":s.substr(a,b-a+1);}
static std::map<std::string,std::string> yaml(const std::string&p){std::ifstream f(p);if(!f)throw std::runtime_error("cannot open "+p);std::map<std::string,std::string>m;std::string l;while(getline(f,l)){auto q=l.find(':');if(q!=std::string::npos)m[trim(l.substr(0,q))]=trim(l.substr(q+1));}return m;}
template<class M> static double d(const M&m,const char*k,double v){auto i=m.find(k);return i==m.end()?v:stod(i->second);}
template<class M> static std::string s(const M&m,const char*k,std::string v){auto i=m.find(k);return i==m.end()?v:i->second;}
static std::vector<double> arr(const std::string&t){auto a=t.find('['),b=t.find(']');std::vector<double>v;if(a==std::string::npos||b==std::string::npos)return v;std::stringstream q(t.substr(a+1,b-a-1));std::string x;while(getline(q,x,','))v.push_back(stod(trim(x)));return v;}

struct Camera {double fx,fy,cx,cy,k[5]{};};
static Camera camera_yaml(const std::string&p,int outw,int outh){std::ifstream f(p);if(!f)throw std::runtime_error("cannot open "+p);std::string all((std::istreambuf_iterator<char>(f)),{});auto take=[&](const char*key){auto n=all.find(key);if(n==std::string::npos)return std::vector<double>{};return arr(all.substr(n));};auto scalar=[&](const char*key){auto n=all.find(key);if(n==std::string::npos)return 0.;n=all.find(':',n);return n==std::string::npos?0.:stod(all.substr(n+1));};auto K=take("camera_matrix"),D=take("distortion_coefficients");double iw=scalar("image_width"),ih=scalar("image_height");if(K.size()<9||D.size()<4||iw<=0||ih<=0)throw std::runtime_error("invalid camera YAML");double sx=outw/iw,sy=outh/ih;Camera c{K[0]*sx,K[4]*sy,K[2]*sx,K[5]*sy};for(size_t i=0;i<std::min<size_t>(5,D.size());i++)c.k[i]=D[i];return c;}

struct Link {int bridge=-1;uint8_t seq=0;std::thread worker;
static void sendall(int fd,const uint8_t*p,size_t n){while(n){ssize_t z=send(fd,p,n,MSG_NOSIGNAL);if(z>0){p+=z;n-=z;}else if(errno!=EINTR)throw std::runtime_error("MAVLink proxy send failed");}}
Link(const std::string&host,int bp){bridge=socket(AF_INET,SOCK_STREAM,0);if(bridge<0)throw std::runtime_error("bridge socket failed");sockaddr_in a{};a.sin_family=AF_INET;a.sin_port=htons(bp);if(inet_pton(AF_INET,host.c_str(),&a.sin_addr)!=1||connect(bridge,(sockaddr*)&a,sizeof(a))<0)throw std::runtime_error("connect MAVLink bridge failed");worker=std::thread(&Link::loop,this);}
~Link(){if(bridge>=0)shutdown(bridge,SHUT_RDWR);if(worker.joinable())worker.join();if(bridge>=0)close(bridge);}
void loop(){uint8_t buf[2048];while(run){pollfd p{bridge,POLLIN,0};int ready=poll(&p,1,100);if(ready<0){if(errno==EINTR)continue;run=false;break;}if(ready&&p.revents&(POLLIN|POLLERR|POLLHUP)){ssize_t n=recv(bridge,buf,sizeof(buf),0);if(n<=0){std::cerr<<"MAVLink bridge disconnected\n";run=false;break;}}}}
static void put16(std::vector<uint8_t>&v,uint16_t x){v.push_back(x);v.push_back(x>>8);}static void put32(std::vector<uint8_t>&v,uint32_t x){for(int i=0;i<4;i++)v.push_back(x>>(8*i));}static void put64(std::vector<uint8_t>&v,uint64_t x){for(int i=0;i<8;i++)v.push_back(x>>(8*i));}static void fl(std::vector<uint8_t>&v,float x){uint32_t z;memcpy(&z,&x,4);put32(v,z);}static void crc(uint16_t&c,uint8_t x){x^=c&255;x^=x<<4;c=(c>>8)^(x<<8)^(x<<3)^(x>>4);}void landing(float x,float y,float z,bool valid){std::vector<uint8_t>p;put64(p,usec());fl(p,atan2f(y,z));fl(p,atan2f(x,z));fl(p,sqrtf(x*x+y*y+z*z));fl(p,0);fl(p,0);p.push_back(0);p.push_back(12);fl(p,x);fl(p,y);fl(p,z);for(int i=0;i<4;i++)fl(p,i==0?1:0);p.push_back(0);p.push_back(valid);std::vector<uint8_t>m{0xfd,(uint8_t)p.size(),0,0,seq++,1,191,149,0,0};m.insert(m.end(),p.begin(),p.end());uint16_t c=0xffff;for(size_t i=1;i<m.size();i++)crc(c,m[i]);crc(c,200);put16(m,c);sendall(bridge,m.data(),m.size());}};

struct P {double x,y,z,err;};
// Four-corner planar solvePnP: AprilTag homography initialization plus iterative pose refinement.
static bool solvePnP(apriltag_detection_t*det,const Camera&c,double size,P&o){
  // Undistort corners before the AprilTag planar solvePnP refinement. The
  // original distorted corners remain the reference for the quality gate.
  apriltag_detection_t ud=*det;
  for(int n=0;n<4;n++){double xd=(det->p[n][0]-c.cx)/c.fx,yd=(det->p[n][1]-c.cy)/c.fy,x=xd,y=yd;
    for(int it=0;it<6;it++){double r=x*x+y*y,rad=1+c.k[0]*r+c.k[1]*r*r+c.k[4]*r*r*r;
      double tx=2*c.k[2]*x*y+c.k[3]*(r+2*x*x),ty=c.k[2]*(r+2*y*y)+2*c.k[3]*x*y;x=(xd-tx)/rad;y=(yd-ty)/rad;}
    ud.p[n][0]=c.fx*x+c.cx;ud.p[n][1]=c.fy*y+c.cy;}
  apriltag_detection_info_t i{&ud,size,c.fx,c.fy,c.cx,c.cy};apriltag_pose_t p{};estimate_tag_pose(&i,&p);if(!p.t||MATD_EL(p.t,2,0)<=0)return false;o={MATD_EL(p.t,0,0),MATD_EL(p.t,1,0),MATD_EL(p.t,2,0),0};double hs=size/2,world[4][3]={{-hs,hs,0},{hs,hs,0},{hs,-hs,0},{-hs,-hs,0}};for(int n=0;n<4;n++){double X=0;for(int j=0;j<3;j++)X+=MATD_EL(p.R,0,j)*world[n][j];double Y=0;for(int j=0;j<3;j++)Y+=MATD_EL(p.R,1,j)*world[n][j];double Z=0;for(int j=0;j<3;j++)Z+=MATD_EL(p.R,2,j)*world[n][j];X+=o.x;Y+=o.y;Z+=o.z;double xn=X/Z,yn=Y/Z,r=xn*xn+yn*yn,rad=1+c.k[0]*r+c.k[1]*r*r+c.k[4]*r*r*r;double u=c.fx*(xn*rad+2*c.k[2]*xn*yn+c.k[3]*(r+2*xn*xn))+c.cx;double v=c.fy*(yn*rad+c.k[2]*(r+2*yn*yn)+2*c.k[3]*xn*yn)+c.cy;o.err+=hypot(u-det->p[n][0],v-det->p[n][1]);}o.err/=4;matd_destroy(p.R);matd_destroy(p.t);return true;}
static double med(double a,double b,double c){return a+b+c-std::min({a,b,c})-std::max({a,b,c});}

struct IgnoreSigpipe { IgnoreSigpipe(){ signal(SIGPIPE,SIG_IGN); } };
static IgnoreSigpipe ignore_sigpipe;

struct StatusPublisher {
  int listener=-1,client=-1;
  StatusPublisher(){listener=socket(AF_INET,SOCK_STREAM,0);if(listener>=0){int yes=1;setsockopt(listener,SOL_SOCKET,SO_REUSEADDR,&yes,sizeof(yes));fcntl(listener,F_SETFL,fcntl(listener,F_GETFL,0)|O_NONBLOCK);sockaddr_in a{};a.sin_family=AF_INET;a.sin_port=htons(14551);a.sin_addr.s_addr=INADDR_ANY;if(bind(listener,(sockaddr*)&a,sizeof(a))<0||listen(listener,1)<0){close(listener);listener=-1;}}}
  ~StatusPublisher(){if(client>=0)close(client);if(listener>=0)close(listener);}
  void sendLine(const char*line){if(listener<0)return;if(client<0)client=accept(listener,nullptr,nullptr);if(client<0)return;char out[192];int n=snprintf(out,sizeof(out),"%s\n",line);if(send(client,out,n,MSG_DONTWAIT|MSG_NOSIGNAL)<0&&errno!=EAGAIN&&errno!=EWOULDBLOCK){close(client);client=-1;}}
};

int main(int ac,char**av){
  std::string cp="Config/Camera.yaml",lp="Config/Landing.yaml";
  int rtsp_mode=1;
  for(int i=1;i<ac;i++){
    std::string arg=av[i];
    if(arg=="--camera"&&i+1<ac)cp=av[++i];
    else if(arg=="--config"&&i+1<ac)lp=av[++i];
    else if((arg=="-rtsp"||arg=="--rtsp")&&i+1<ac)rtsp_mode=std::stoi(av[++i]);
    else {std::cerr<<"Unknown or incomplete argument: "<<arg<<"\nUsage: luckfox_landing [--camera FILE] [--config FILE] [-rtsp 0|1]\n";return 2;}
  }
  if(rtsp_mode<0||rtsp_mode>1){std::cerr<<"-rtsp must be 0 or 1\n";return 2;}
  try{
    auto m=yaml(lp);Cfg q;
    q.dev=s(m,"camera_device",q.dev);q.uart=s(m,"uart_device",q.uart);q.baud=d(m,"uart_baud",q.baud);
    q.host=s(m,"mavlink_bridge_host",q.host);q.bridge_port=d(m,"mavlink_bridge_port",q.bridge_port);
    q.w=d(m,"width",q.w);q.h=d(m,"height",q.h);q.id=d(m,"tag_id",q.id);q.size=d(m,"tag_size_m",q.size);
    q.ox=d(m,"camera_offset_x_m",0);q.oy=d(m,"camera_offset_y_m",0);q.oz=d(m,"camera_offset_z_m",0);
    q.maxerr=d(m,"max_reprojection_error_px",2);q.margin=d(m,"min_decision_margin",35);q.ham=d(m,"max_hamming",0);
    q.lost=d(m,"lost_timeout_ms",300);q.hz=d(m,"inference_hz",10);q.threads=d(m,"apriltag_threads",2);q.decimate=d(m,"quad_decimate",1.5);
    if(q.hz<1||q.hz>30)throw std::runtime_error("inference_hz must be 1..30");
    Camera cam=camera_yaml(cp,q.w,q.h);Link uart(q.host,q.bridge_port);
    StreamingPipeline pipe(q.w,q.h,q.hz,500,8,8554,"/live","/etc/iqfiles",rtsp_mode);
    std::cerr<<"Landing started: rtsp="<<rtsp_mode<<" inference="<<q.w<<"x"<<q.h<<" @ "<<q.hz<<" Hz\n";
    StreamingPipeline::Frame frame;auto*tf=tag36h11_create();auto*td=apriltag_detector_create();
    apriltag_detector_add_family(td,tf);td->nthreads=q.threads;td->quad_decimate=q.decimate;td->refine_edges=0;
    std::array<P,3> hist{};int hn=0;uint64_t seen=0;bool lost=false;
    uint64_t report_start=usec();unsigned report_frames=0;StatusPublisher status;
    signal(SIGINT,sig);signal(SIGTERM,sig);
    while(run){
      if(!pipe.acquire(frame,200))continue;
      uint64_t now=usec();image_u8_t im={q.w,q.h,q.w,frame.y};zarray_t*z=apriltag_detector_detect(td,&im);
      P best{};bool ok=false;
      for(int n=0;n<zarray_size(z);n++){apriltag_detection_t*x;zarray_get(z,n,&x);P p;if(x->id==q.id&&x->hamming<=q.ham&&x->decision_margin>=q.margin&&solvePnP(x,cam,q.size,p)&&p.err<=q.maxerr){best=p;ok=true;break;}}
      if(ok){hist[hn%3]=best;hn++;seen=now;lost=false;if(hn>=3){auto&a=hist[0],&b=hist[1],&c=hist[2];double cx=med(a.x,b.x,c.x),cy=med(a.y,b.y,c.y),cz=med(a.z,b.z,c.z);float bx=q.ox+cy,by=q.oy+cx,bz=q.oz+cz;uart.landing(bx,by,bz,true);}}
      else if(seen&&now-seen>(uint64_t)q.lost*1000&&!lost){uart.landing(0,0,0,false);lost=true;}
      if(!pipe.publish(frame))std::cerr<<"VENC dropped frame\n";
      apriltag_detections_destroy(z);
      report_frames++;
      uint64_t report_now=usec();
      if(report_now-report_start>=200000){double rate=report_frames*1000000.0/(report_now-report_start);char line[176];snprintf(line,sizeof(line),"TAG=%s infer=%.2fHz X=%.3f Y=%.3f Z=%.3f MAV=%s",ok?"FOUND":"LOST",rate,ok?best.x:0.0,ok?best.y:0.0,ok?best.z:0.0,(ok&&hn>=3)?"VALID":"INVALID");std::cerr<<line<<"\n";status.sendLine(line);report_start=report_now;report_frames=0;}
    }
    pipe.release(frame);apriltag_detector_destroy(td);tag36h11_destroy(tf);
  }catch(const std::exception&e){std::cerr<<"luckfox_landing: "<<e.what()<<"\n";return 1;}
  return 0;
}
