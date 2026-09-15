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
#include <vector>
#include <fcntl.h>
#include <linux/videodev2.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <termios.h>
#include <unistd.h>
extern "C" {
#include "apriltag.h"
#include "apriltag_pose.h"
#include "tag36h11.h"
}

static std::atomic<bool> run{true};
static void sig(int){run=false;}
static uint64_t usec(){return std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();}

struct Cfg {std::string dev="/dev/video11",uart="/dev/ttyS5";int baud=115200,w=1280,h=720,id=0,ham=0,lost=300,threads=2;double size=.2,ox=0,oy=0,oz=0,maxerr=2,margin=35,decimate=1.5;};
static std::string trim(std::string s){auto a=s.find_first_not_of(" \t");auto b=s.find_last_not_of(" \t\r");return a==std::string::npos?"":s.substr(a,b-a+1);}
static std::map<std::string,std::string> yaml(const std::string&p){std::ifstream f(p);if(!f)throw std::runtime_error("cannot open "+p);std::map<std::string,std::string>m;std::string l;while(getline(f,l)){auto q=l.find(':');if(q!=std::string::npos)m[trim(l.substr(0,q))]=trim(l.substr(q+1));}return m;}
template<class M> static double d(const M&m,const char*k,double v){auto i=m.find(k);return i==m.end()?v:stod(i->second);}
template<class M> static std::string s(const M&m,const char*k,std::string v){auto i=m.find(k);return i==m.end()?v:i->second;}
static std::vector<double> arr(const std::string&t){auto a=t.find('['),b=t.find(']');std::vector<double>v;if(a==std::string::npos||b==std::string::npos)return v;std::stringstream q(t.substr(a+1,b-a-1));std::string x;while(getline(q,x,','))v.push_back(stod(trim(x)));return v;}

struct Camera {double fx,fy,cx,cy,k[5]{};};
static Camera camera_yaml(const std::string&p){std::ifstream f(p);if(!f)throw std::runtime_error("cannot open "+p);std::string all((std::istreambuf_iterator<char>(f)),{});auto take=[&](const char*key){auto n=all.find(key);if(n==std::string::npos)return std::vector<double>{};return arr(all.substr(n));};auto K=take("camera_matrix"),D=take("distortion_coefficients");if(K.size()<9||D.size()<4)throw std::runtime_error("invalid camera YAML");Camera c{K[0],K[4],K[2],K[5]};for(size_t i=0;i<std::min<size_t>(5,D.size());i++)c.k[i]=D[i];return c;}

struct Capture {int fd=-1;void*ptr=nullptr;size_t len=0;int w,h;std::vector<uint8_t>gray;Capture(const std::string&dev,int W,int H):w(W),h(H){fd=open(dev.c_str(),O_RDWR|O_NONBLOCK);if(fd<0)throw std::runtime_error("open V4L2 failed");v4l2_format f{};f.type=V4L2_BUF_TYPE_VIDEO_CAPTURE;f.fmt.pix.width=w;f.fmt.pix.height=h;f.fmt.pix.pixelformat=V4L2_PIX_FMT_NV12;f.fmt.pix.field=V4L2_FIELD_NONE;if(ioctl(fd,VIDIOC_S_FMT,&f)<0)throw std::runtime_error("V4L2 NV12 format failed");w=f.fmt.pix.width;h=f.fmt.pix.height;gray.resize((size_t)w*h);v4l2_requestbuffers r{};r.count=1;r.type=f.type;r.memory=V4L2_MEMORY_MMAP;if(ioctl(fd,VIDIOC_REQBUFS,&r)<0)throw std::runtime_error("V4L2 mmap request failed");v4l2_buffer b{};b.type=f.type;b.memory=r.memory;b.index=0;if(ioctl(fd,VIDIOC_QUERYBUF,&b)<0)throw std::runtime_error("V4L2 query failed");len=b.length;ptr=mmap(nullptr,len,PROT_READ|PROT_WRITE,MAP_SHARED,fd,b.m.offset);ioctl(fd,VIDIOC_QBUF,&b);int t=f.type;if(ioctl(fd,VIDIOC_STREAMON,&t)<0)throw std::runtime_error("V4L2 stream-on failed");}
~Capture(){if(fd>=0){int t=V4L2_BUF_TYPE_VIDEO_CAPTURE;ioctl(fd,VIDIOC_STREAMOFF,&t);}if(ptr&&ptr!=MAP_FAILED)munmap(ptr,len);if(fd>=0)close(fd);}bool frame(image_u8_t&im){fd_set x;FD_ZERO(&x);FD_SET(fd,&x);timeval tv{0,50000};if(select(fd+1,&x,nullptr,nullptr,&tv)<=0)return false;v4l2_buffer b{};b.type=V4L2_BUF_TYPE_VIDEO_CAPTURE;b.memory=V4L2_MEMORY_MMAP;if(ioctl(fd,VIDIOC_DQBUF,&b)<0)return false;memcpy(gray.data(),ptr,gray.size());ioctl(fd,VIDIOC_QBUF,&b);im={w,h,w,gray.data()};return true;}};

static speed_t baud(int b){return b==57600?B57600:B115200;}
struct Uart {int fd;uint8_t seq=0;Uart(const std::string&p,int b){fd=open(p.c_str(),O_WRONLY|O_NOCTTY|O_NONBLOCK);if(fd<0)throw std::runtime_error("open UART failed");termios t{};tcgetattr(fd,&t);cfmakeraw(&t);cfsetispeed(&t,baud(b));cfsetospeed(&t,baud(b));t.c_cflag|=CLOCAL|CREAD;tcsetattr(fd,TCSANOW,&t);}~Uart(){close(fd);}static void put16(std::vector<uint8_t>&v,uint16_t x){v.push_back(x);v.push_back(x>>8);}static void put32(std::vector<uint8_t>&v,uint32_t x){for(int i=0;i<4;i++)v.push_back(x>>(8*i));}static void put64(std::vector<uint8_t>&v,uint64_t x){for(int i=0;i<8;i++)v.push_back(x>>(8*i));}static void fl(std::vector<uint8_t>&v,float x){uint32_t z;memcpy(&z,&x,4);put32(v,z);}static void crc(uint16_t&c,uint8_t x){x^=c&255;x^=x<<4;c=(c>>8)^(x<<8)^(x<<3)^(x>>4);}void landing(float x,float y,float z,bool valid){std::vector<uint8_t>p;put64(p,usec());fl(p,atan2f(y,z));fl(p,atan2f(x,z));fl(p,sqrtf(x*x+y*y+z*z));fl(p,0);fl(p,0);p.push_back(0);p.push_back(12);fl(p,x);fl(p,y);fl(p,z);for(int i=0;i<4;i++)fl(p,i==0?1:0);p.push_back(0);p.push_back(valid);std::vector<uint8_t>m{0xfd,(uint8_t)p.size(),0,0,seq++,1,191,149,0,0};m.insert(m.end(),p.begin(),p.end());uint16_t c=0xffff;for(size_t i=1;i<m.size();i++)crc(c,m[i]);crc(c,200);put16(m,c);write(fd,m.data(),m.size());}};

struct P {double x,y,z,err;};
// Four-corner planar solvePnP: AprilTag homography initialization plus iterative pose refinement.
static bool solvePnP(apriltag_detection_t*det,const Camera&c,double size,P&o){apriltag_detection_info_t i{det,size,c.fx,c.fy,c.cx,c.cy};apriltag_pose_t p{};estimate_tag_pose(&i,&p);if(!p.t||MATD_EL(p.t,2,0)<=0)return false;o={MATD_EL(p.t,0,0),MATD_EL(p.t,1,0),MATD_EL(p.t,2,0),0};double hs=size/2,world[4][3]={{-hs,hs,0},{hs,hs,0},{hs,-hs,0},{-hs,-hs,0}};for(int n=0;n<4;n++){double X=0;for(int j=0;j<3;j++)X+=MATD_EL(p.R,0,j)*world[n][j];double Y=0;for(int j=0;j<3;j++)Y+=MATD_EL(p.R,1,j)*world[n][j];double Z=0;for(int j=0;j<3;j++)Z+=MATD_EL(p.R,2,j)*world[n][j];X+=o.x;Y+=o.y;Z+=o.z;double xn=X/Z,yn=Y/Z,r=xn*xn+yn*yn,rad=1+c.k[0]*r+c.k[1]*r*r+c.k[4]*r*r*r;double u=c.fx*(xn*rad+2*c.k[2]*xn*yn+c.k[3]*(r+2*xn*xn))+c.cx;double v=c.fy*(yn*rad+c.k[2]*(r+2*yn*yn)+2*c.k[3]*xn*yn)+c.cy;o.err+=hypot(u-det->p[n][0],v-det->p[n][1]);}o.err/=4;matd_destroy(p.R);matd_destroy(p.t);return true;}
static double med(double a,double b,double c){return a+b+c-std::min({a,b,c})-std::max({a,b,c});}

int main(int ac,char**av){std::string cp="Config/Camera.yaml",lp="Config/Landing.yaml";for(int i=1;i<ac;i++){if(std::string(av[i])=="--camera"&&i+1<ac)cp=av[++i];else if(std::string(av[i])=="--config"&&i+1<ac)lp=av[++i];}try{auto m=yaml(lp);Cfg q;q.dev=s(m,"camera_device",q.dev);q.uart=s(m,"uart_device",q.uart);q.baud=d(m,"uart_baud",q.baud);q.w=d(m,"width",q.w);q.h=d(m,"height",q.h);q.id=d(m,"tag_id",q.id);q.size=d(m,"tag_size_m",q.size);q.ox=d(m,"camera_offset_x_m",0);q.oy=d(m,"camera_offset_y_m",0);q.oz=d(m,"camera_offset_z_m",0);q.maxerr=d(m,"max_reprojection_error_px",2);q.margin=d(m,"min_decision_margin",35);q.ham=d(m,"max_hamming",0);q.lost=d(m,"lost_timeout_ms",300);q.threads=d(m,"apriltag_threads",2);q.decimate=d(m,"quad_decimate",1.5);Camera cam=camera_yaml(cp);Capture cap(q.dev,q.w,q.h);Uart uart(q.uart,q.baud);auto*tf=tag36h11_create();auto*td=apriltag_detector_create();apriltag_detector_add_family(td,tf);td->nthreads=q.threads;td->quad_decimate=q.decimate;td->refine_edges=1;std::array<P,3> hist{};int hn=0;uint64_t seen=0;bool lost=false;signal(SIGINT,sig);signal(SIGTERM,sig);while(run){image_u8_t im;if(!cap.frame(im))continue;zarray_t*z=apriltag_detector_detect(td,&im);P best{};bool ok=false;for(int n=0;n<zarray_size(z);n++){apriltag_detection_t*x;zarray_get(z,n,&x);P p;if(x->id==q.id&&x->hamming<=q.ham&&x->decision_margin>=q.margin&&solvePnP(x,cam,q.size,p)&&p.err<=q.maxerr){best=p;ok=true;break;}}if(ok){hist[hn%3]=best;hn++;seen=usec();lost=false;if(hn>=3){auto&a=hist[0],&b=hist[1],&c=hist[2];double cx=med(a.x,b.x,c.x),cy=med(a.y,b.y,c.y),cz=med(a.z,b.z,c.z);float bx=q.ox+cy,by=q.oy+cx,bz=q.oz+cz;uart.landing(bx,by,bz,true);}}else if(seen&&usec()-seen>(uint64_t)q.lost*1000&&!lost){uart.landing(0,0,0,false);lost=true;}apriltag_detections_destroy(z);}apriltag_detector_destroy(td);tag36h11_destroy(tf);}catch(const std::exception&e){std::cerr<<"luckfox_landing: "<<e.what()<<"\n";return 1;}return 0;}
