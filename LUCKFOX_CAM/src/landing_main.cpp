#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cmath>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <mutex>
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
#include <sys/stat.h>
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

struct Cfg {std::string dev="/dev/video11",uart="/dev/ttyS5",host="127.0.0.1";int baud=115200,bridge_port=5761,w=1280,h=720,ham=0,lost=300,target_holdover=0,tier_reset=5000,hz=10,threads=2,switch_frames=12,single_tag=1,snapshots=0,snapshot_interval=2000,snapshot_limit=60,snapshot_w=160,snapshot_h=90,guided_hold=0,guided_mode=20,guided_sysid=1,guided_compid=1,guided_heartbeat_timeout=2000,guided_attitude_timeout=1000,vision_position=0,vision_attitude_timeout=500;double ox=0,oy=0,oz=0,maxerr=2,margin=35,decimate=1.0,min_hz=6,range_min=.1,range_max=3,filter_alpha=.35,match_m=.05,min_tag_px=12,max_xy_jump=.15,max_z_jump=.25,max_xy_speed=1.0,max_z_speed=1.5,medium_below=1.5,small_below=.75,medium_above=1.8,small_above=.95,small_fast_alt=.75,min_confidence=.35,large_min=.6,large_max=4.5,medium_min=.4,medium_max=3.0,small_min=.2,small_max=2.0,guided_kp=0.20,guided_deadband=.03,guided_max_tilt_deg=8,guided_climb_neutral=.5,vision_pos_sigma=.10,vision_ang_sigma=.10,exposure_min_us=100,exposure_max_us=2000,exposure_gain_min=1,exposure_gain_max=32;};
static std::string trim(std::string s){auto a=s.find_first_not_of(" \t");auto b=s.find_last_not_of(" \t\r");return a==std::string::npos?"":s.substr(a,b-a+1);}
static std::map<std::string,std::string> yaml(const std::string&p){std::ifstream f(p);if(!f)throw std::runtime_error("cannot open "+p);std::map<std::string,std::string>m;std::string l;while(getline(f,l)){auto q=l.find(':');if(q!=std::string::npos)m[trim(l.substr(0,q))]=trim(l.substr(q+1));}return m;}
template<class M> static double d(const M&m,const char*k,double v){auto i=m.find(k);return i==m.end()?v:stod(i->second);}
template<class M> static std::string s(const M&m,const char*k,std::string v){auto i=m.find(k);return i==m.end()?v:i->second;}
static std::vector<double> arr(const std::string&t){auto a=t.find('['),b=t.find(']');std::vector<double>v;if(a==std::string::npos||b==std::string::npos)return v;std::stringstream q(t.substr(a+1,b-a-1));std::string x;while(getline(q,x,','))v.push_back(stod(trim(x)));return v;}

struct Camera {double fx,fy,cx,cy,k[5]{};};
static Camera camera_yaml(const std::string&p,int outw,int outh){std::ifstream f(p);if(!f)throw std::runtime_error("cannot open "+p);std::string all((std::istreambuf_iterator<char>(f)),{});auto take=[&](const char*key){auto n=all.find(key);if(n==std::string::npos)return std::vector<double>{};return arr(all.substr(n));};auto scalar=[&](const char*key){auto n=all.find(key);if(n==std::string::npos)return 0.;n=all.find(':',n);return n==std::string::npos?0.:stod(all.substr(n+1));};auto K=take("camera_matrix"),D=take("distortion_coefficients");double iw=scalar("image_width"),ih=scalar("image_height");if(K.size()<9||D.size()<4||iw<=0||ih<=0)throw std::runtime_error("invalid camera YAML");double sx=outw/iw,sy=outh/ih;Camera c{K[0]*sx,K[4]*sy,K[2]*sx,K[5]*sy};for(size_t i=0;i<std::min<size_t>(5,D.size());i++)c.k[i]=D[i];return c;}

struct Link {int bridge=-1;uint8_t seq=0,target_system=1,target_component=1;std::thread worker;std::atomic<uint32_t> custom_mode{0};std::atomic<uint8_t> base_mode{0};std::atomic<uint16_t> ekf_flags{0};std::atomic<uint64_t> heartbeat_us{0},attitude_us{0},ekf_us{0};std::atomic<float> roll_rad{0},pitch_rad{0},yaw_rad{0},vision_n{0},vision_e{0},vision_d{0};
static void sendall(int fd,const uint8_t*p,size_t n){while(n){ssize_t z=send(fd,p,n,MSG_NOSIGNAL);if(z>0){p+=z;n-=z;}else if(errno!=EINTR)throw std::runtime_error("MAVLink proxy send failed");}}
Link(const std::string&host,int bp,int sysid=1,int compid=1):target_system(sysid),target_component(compid){bridge=socket(AF_INET,SOCK_STREAM,0);if(bridge<0)throw std::runtime_error("bridge socket failed");sockaddr_in a{};a.sin_family=AF_INET;a.sin_port=htons(bp);if(inet_pton(AF_INET,host.c_str(),&a.sin_addr)!=1||connect(bridge,(sockaddr*)&a,sizeof(a))<0)throw std::runtime_error("connect MAVLink bridge failed");worker=std::thread(&Link::loop,this);}
~Link(){if(bridge>=0)shutdown(bridge,SHUT_RDWR);if(worker.joinable())worker.join();if(bridge>=0)close(bridge);}
void parse(const uint8_t*b,size_t n){static std::vector<uint8_t>q;q.insert(q.end(),b,b+n);while(!q.empty()){auto i=std::find_if(q.begin(),q.end(),[](uint8_t x){return x==0xfd||x==0xfe;});if(i!=q.begin())q.erase(q.begin(),i);if(q.empty())break;bool v2=q[0]==0xfd;size_t header=v2?10:6;if(q.size()<header)break;size_t total=header+q[1]+2+(v2&&(q[2]&1)?13:0);if(q.size()<total)break;uint8_t sys=q[v2?5:3];uint32_t id=v2?(q[7]|(q[8]<<8)|(q[9]<<16)):q[5];const uint8_t*p=q.data()+header;if(sys==target_system&&id==0&&q[1]>=9){uint32_t mode;memcpy(&mode,p,4);custom_mode=mode;base_mode=p[6];heartbeat_us=usec();}else if(sys==target_system&&id==30&&q[1]>=16){float roll,pitch,yaw;memcpy(&roll,p+4,4);memcpy(&pitch,p+8,4);memcpy(&yaw,p+12,4);if(std::isfinite(roll)&&std::isfinite(pitch)&&std::isfinite(yaw)){roll_rad=roll;pitch_rad=pitch;yaw_rad=yaw;attitude_us=usec();}}else if(sys==target_system&&id==193&&q[1]>=22){uint16_t flags;memcpy(&flags,p+20,2);ekf_flags=flags;ekf_us=usec();}q.erase(q.begin(),q.begin()+total);}}
void loop(){uint8_t buf[2048];while(run){pollfd p{bridge,POLLIN,0};int ready=poll(&p,1,100);if(ready<0){if(errno==EINTR)continue;run=false;break;}if(ready&&p.revents&(POLLIN|POLLERR|POLLHUP)){ssize_t n=recv(bridge,buf,sizeof(buf),0);if(n<=0){std::cerr<<"MAVLink bridge disconnected\n";run=false;break;}parse(buf,n);}}}
static void put16(std::vector<uint8_t>&v,uint16_t x){v.push_back(x);v.push_back(x>>8);}static void put32(std::vector<uint8_t>&v,uint32_t x){for(int i=0;i<4;i++)v.push_back(x>>(8*i));}static void put64(std::vector<uint8_t>&v,uint64_t x){for(int i=0;i<8;i++)v.push_back(x>>(8*i));}static void fl(std::vector<uint8_t>&v,float x){uint32_t z;memcpy(&z,&x,4);put32(v,z);}static void crc(uint16_t&c,uint8_t x){x^=c&255;x^=x<<4;c=(c>>8)^(x<<8)^(x<<3)^(x>>4);}void message(uint32_t id,uint8_t extra,const std::vector<uint8_t>&p){std::vector<uint8_t>m{0xfd,(uint8_t)p.size(),0,0,seq++,1,191,(uint8_t)id,(uint8_t)(id>>8),(uint8_t)(id>>16)};m.insert(m.end(),p.begin(),p.end());uint16_t c=0xffff;for(size_t i=1;i<m.size();i++)crc(c,m[i]);crc(c,extra);put16(m,c);sendall(bridge,m.data(),m.size());}
void requestInterval(uint32_t id,float hz){std::vector<uint8_t>p;fl(p,id);fl(p,hz>0?1000000.0f/hz:-1.0f);for(int i=0;i<5;i++)fl(p,0);put16(p,511);p.push_back(target_system);p.push_back(target_component);p.push_back(0);message(76,152,p);}
void landing(float x,float y,float z,bool valid){std::vector<uint8_t>p;put64(p,usec());fl(p,atan2f(y,z));fl(p,atan2f(x,z));fl(p,sqrtf(x*x+y*y+z*z));fl(p,0);fl(p,0);p.push_back(0);p.push_back(12);fl(p,x);fl(p,y);fl(p,z);for(int i=0;i<4;i++)fl(p,i==0?1:0);p.push_back(0);p.push_back(valid);message(149,200,p);}
void distance(float z,float min_m,float max_m){uint16_t mn=std::max(1,std::min(65535,(int)lround(min_m*100))),mx=std::max((int)mn,std::min(65535,(int)lround(max_m*100))),cur=std::max((int)mn,std::min((int)mx,(int)lround(z*100)));std::vector<uint8_t>p;put32(p,(uint32_t)(usec()/1000));put16(p,mn);put16(p,mx);put16(p,cur);p.push_back(0);p.push_back(0);p.push_back(25);p.push_back(0);fl(p,0);fl(p,0);for(int i=0;i<4;i++)fl(p,0);p.push_back(100);message(132,85,p);}
void attitude(float roll,float pitch,float yaw,float neutral){double cr=cos(roll*.5),sr=sin(roll*.5),cp=cos(pitch*.5),sp=sin(pitch*.5),cy=cos(yaw*.5),sy=sin(yaw*.5);std::vector<uint8_t>p;put32(p,(uint32_t)(usec()/1000));fl(p,cr*cp*cy+sr*sp*sy);fl(p,sr*cp*cy-cr*sp*sy);fl(p,cr*sp*cy+sr*cp*sy);fl(p,cr*cp*sy-sr*sp*cy);fl(p,0);fl(p,0);fl(p,0);fl(p,neutral);p.push_back(target_system);p.push_back(target_component);p.push_back(7);message(82,49,p);}
bool vision(float target_forward,float target_right,float target_down,int attitude_timeout,float pos_sigma,float ang_sigma){const uint64_t attitude_stamp=attitude_us.load(),now=usec();if(!attitude_stamp||now-attitude_stamp>(uint64_t)attitude_timeout*1000)return false;const float roll=roll_rad.load(),pitch=pitch_rad.load(),yaw=yaw_rad.load();const float cr=cosf(roll),sr=sinf(roll),cp=cosf(pitch),sp=sinf(pitch),cy=cosf(yaw),sy=sinf(yaw);const float target_n=(cp*cy)*target_forward+(sr*sp*cy-cr*sy)*target_right+(cr*sp*cy+sr*sy)*target_down;const float target_e=(cp*sy)*target_forward+(sr*sp*sy+cr*cy)*target_right+(cr*sp*sy-sr*cy)*target_down;const float target_d=(-sp)*target_forward+(sr*cp)*target_right+(cr*cp)*target_down;const float vehicle_n=-target_n,vehicle_e=-target_e,vehicle_d=-target_d;vision_n=vehicle_n;vision_e=vehicle_e;vision_d=vehicle_d;std::vector<uint8_t>p;put64(p,now);fl(p,vehicle_n);fl(p,vehicle_e);fl(p,vehicle_d);fl(p,roll);fl(p,pitch);fl(p,yaw);const float pos_var=pos_sigma*pos_sigma,ang_var=ang_sigma*ang_sigma;for(int i=0;i<21;i++)fl(p,(i==0||i==6||i==11)?pos_var:((i==15||i==18||i==20)?ang_var:0));p.push_back(0);message(102,158,p);return true;}
bool guidedReady(int mode,int heartbeat_timeout,int attitude_timeout)const{const uint64_t heartbeat=heartbeat_us.load(),attitude=attitude_us.load(),now=usec();return (base_mode.load()&128)&&custom_mode.load()==(uint32_t)mode&&now-heartbeat<=(uint64_t)heartbeat_timeout*1000&&now-attitude<=(uint64_t)attitude_timeout*1000;}};

struct P {double x=0,y=0,z=0,err=0,R[9]{};};
// Four-corner planar solvePnP: AprilTag homography initialization plus iterative pose refinement.
static bool solvePnP(apriltag_detection_t*det,const Camera&c,double size,P&o){
  // Undistort corners before the AprilTag planar solvePnP refinement. The
  // original distorted corners remain the reference for the quality gate.
  apriltag_detection_t ud=*det;
  for(int n=0;n<4;n++){double xd=(det->p[n][0]-c.cx)/c.fx,yd=(det->p[n][1]-c.cy)/c.fy,x=xd,y=yd;
    for(int it=0;it<6;it++){double r=x*x+y*y,rad=1+c.k[0]*r+c.k[1]*r*r+c.k[4]*r*r*r;
      double tx=2*c.k[2]*x*y+c.k[3]*(r+2*x*x),ty=c.k[2]*(r+2*y*y)+2*c.k[3]*x*y;x=(xd-tx)/rad;y=(yd-ty)/rad;}
    ud.p[n][0]=c.fx*x+c.cx;ud.p[n][1]=c.fy*y+c.cy;}
  apriltag_detection_info_t i{&ud,size,c.fx,c.fy,c.cx,c.cy};apriltag_pose_t p{};estimate_tag_pose(&i,&p);if(!p.t||!p.R||MATD_EL(p.t,2,0)<=0)return false;o.x=MATD_EL(p.t,0,0);o.y=MATD_EL(p.t,1,0);o.z=MATD_EL(p.t,2,0);for(int r=0;r<3;r++)for(int col=0;col<3;col++)o.R[r*3+col]=MATD_EL(p.R,r,col);double hs=size/2,world[4][3]={{-hs,hs,0},{hs,hs,0},{hs,-hs,0},{-hs,-hs,0}};for(int n=0;n<4;n++){double X=0;for(int j=0;j<3;j++)X+=o.R[j]*world[n][j];double Y=0;for(int j=0;j<3;j++)Y+=o.R[3+j]*world[n][j];double Z=0;for(int j=0;j<3;j++)Z+=o.R[6+j]*world[n][j];X+=o.x;Y+=o.y;Z+=o.z;double xn=X/Z,yn=Y/Z,r=xn*xn+yn*yn,rad=1+c.k[0]*r+c.k[1]*r*r+c.k[4]*r*r*r;double u=c.fx*(xn*rad+2*c.k[2]*xn*yn+c.k[3]*(r+2*xn*xn))+c.cx;double v=c.fy*(yn*rad+c.k[2]*(r+2*yn*yn)+2*c.k[3]*xn*yn)+c.cy;o.err+=hypot(u-det->p[n][0],v-det->p[n][1]);}o.err/=4;matd_destroy(p.R);matd_destroy(p.t);return true;}
static void drawLine(uint8_t*y,int w,int h,int x0,int y0,int x1,int y1,uint8_t value){
  int dx=std::abs(x1-x0),sx=x0<x1?1:-1,dy=-std::abs(y1-y0),sy=y0<y1?1:-1,err=dx+dy;
  for(;;){for(int oy=-1;oy<=1;oy++)for(int ox=-1;ox<=1;ox++){int x=x0+ox,v=y0+oy;if(x>=0&&x<w&&v>=0&&v<h)y[v*w+x]=value;}if(x0==x1&&y0==y1)break;int e2=2*err;if(e2>=dy){err+=dy;x0+=sx;}if(e2<=dx){err+=dx;y0+=sy;}}
}
static void drawTrackedTag(uint8_t*y,int w,int h,const apriltag_detection_t*det){
  for(int n=0;n<4;n++)drawLine(y,w,h,(int)lround(det->p[n][0]),(int)lround(det->p[n][1]),(int)lround(det->p[(n+1)%4][0]),(int)lround(det->p[(n+1)%4][1]),235);
  int cx=(int)lround(det->c[0]),cy=(int)lround(det->c[1]);drawLine(y,w,h,cx-7,cy,cx+7,cy,235);drawLine(y,w,h,cx,cy-7,cx,cy+7,235);
}

// Positions are measured from the A4 top-left.  With the printed tag rotation
// used by the landing-pad PDF, AprilTag pose +X points toward paper-left and
// pose +Y points toward paper-top.  Negate both paper-axis deltas before the
// tag rotation maps the common PDF landing point into camera coordinates.
struct PadTag {const char*name;int id;double x,y,size;};
struct Candidate {int tag=-1,det=-1;P raw{},center{};double dx=0,dy=0,dz=0,quality=0,pixels=0,confidence=0;};
static P landingCenter(const P&t,const PadTag&g,double lx,double ly){P o=t;double vx=-(lx-(g.x+g.size/2)),vy=-(ly-(g.y+g.size/2));o.x=t.x+t.R[0]*vx+t.R[1]*vy;o.y=t.y+t.R[3]*vx+t.R[4]*vy;o.z=t.z+t.R[6]*vx+t.R[7]*vy;return o;}
static double tagPixels(const apriltag_detection_t*d){double total=0;for(int n=0;n<4;n++)total+=std::hypot(d->p[n][0]-d->p[(n+1)%4][0],d->p[n][1]-d->p[(n+1)%4][1]);return total/4;}
// Simultaneously visible tags describe the same physical pad at the same
// instant, so their landing centres must satisfy the fixed geometry gates.
// Only a comparison against an older centre may grow with vehicle motion.
static double handoffLimit(double fixed_limit,double speed,double elapsed,bool simultaneous){return fixed_limit+(simultaneous?0.0:speed*elapsed);}
static void pngBe32(std::vector<uint8_t>&out,uint32_t value){out.push_back(value>>24);out.push_back(value>>16);out.push_back(value>>8);out.push_back(value);}
static uint32_t pngCrc(const uint8_t*data,size_t size){uint32_t crc=0xffffffff;for(size_t i=0;i<size;i++){crc^=data[i];for(int bit=0;bit<8;bit++)crc=(crc>>1)^(0xedb88320u&-(int32_t)(crc&1));}return ~crc;}
static void pngChunk(std::vector<uint8_t>&png,const char type[4],const std::vector<uint8_t>&data){pngBe32(png,data.size());size_t crc_start=png.size();png.insert(png.end(),type,type+4);png.insert(png.end(),data.begin(),data.end());pngBe32(png,pngCrc(png.data()+crc_start,4+data.size()));}
static std::vector<uint8_t> grayscalePng(const uint8_t*y,int w,int h,int out_w,int out_h){
  std::vector<uint8_t>raw;raw.reserve((out_w+1)*out_h);
  for(int oy=0;oy<out_h;oy++){raw.push_back(0);int sy=std::min(h-1,oy*h/out_h);for(int ox=0;ox<out_w;ox++){int sx=std::min(w-1,ox*w/out_w);raw.push_back(y[sy*w+sx]);}}
  std::vector<uint8_t>z{0x78,0x01};
  for(size_t offset=0;offset<raw.size();){uint16_t block=std::min<size_t>(65535,raw.size()-offset);bool final=offset+block==raw.size();z.push_back(final?1:0);z.push_back(block);z.push_back(block>>8);uint16_t inverse=~block;z.push_back(inverse);z.push_back(inverse>>8);z.insert(z.end(),raw.begin()+offset,raw.begin()+offset+block);offset+=block;}
  uint32_t a=1,b=0;for(uint8_t value:raw){a=(a+value)%65521;b=(b+a)%65521;}pngBe32(z,(b<<16)|a);
  std::vector<uint8_t>png{137,80,78,71,13,10,26,10},ihdr;pngBe32(ihdr,out_w);pngBe32(ihdr,out_h);ihdr.insert(ihdr.end(),{8,0,0,0,0});pngChunk(png,"IHDR",ihdr);pngChunk(png,"IDAT",z);pngChunk(png,"IEND",{});return png;
}
class SnapshotWriter {
  struct Job {std::vector<uint8_t> pixels;int w=0,h=0;std::string path;};
  std::mutex mutex_;std::condition_variable ready_;std::thread worker_;Job job_;bool pending_=false,stopping_=false;
  uint64_t last_=0;int count_=0;std::string previous_dir_;
  void loop(){
    for(;;){
      Job job;{
        std::unique_lock<std::mutex> lock(mutex_);ready_.wait(lock,[&]{return pending_||stopping_;});
        if(!pending_&&stopping_)return;
        job=std::move(job_);pending_=false;
      }
      std::vector<uint8_t>png=grayscalePng(job.pixels.data(),job.w,job.h,job.w,job.h);
      std::string temporary=job.path+".tmp";std::ofstream out(temporary,std::ios::binary|std::ios::trunc);if(!out)continue;
      out.write((const char*)png.data(),png.size());out.flush();bool complete=out.good();out.close();
      if(!complete||rename(temporary.c_str(),job.path.c_str())!=0)unlink(temporary.c_str());
    }
  }
 public:
  SnapshotWriter():worker_(&SnapshotWriter::loop,this){}
  ~SnapshotWriter(){
    {std::lock_guard<std::mutex> lock(mutex_);stopping_=true;}ready_.notify_one();if(worker_.joinable())worker_.join();
  }
  void submit(const uint8_t*y,int w,int h,uint64_t now,const std::string&reason,const Cfg&q){
    if(!q.snapshots||now-last_<(uint64_t)q.snapshot_interval*1000)return;
    {std::lock_guard<std::mutex> lock(mutex_);if(pending_)return;}
    std::ifstream control("/root/logs/precision-landing-sessions/active-session");std::string dir;if(!getline(control,dir)||dir.rfind("/root/logs/precision-landing-sessions/",0)!=0)return;
    if(dir!=previous_dir_){previous_dir_=dir;count_=0;}if(count_>=q.snapshot_limit)return;
    std::string frames=dir+"/frames";mkdir(frames.c_str(),0700);
    std::string safe_reason;for(char c:reason)if((c>='a'&&c<='z')||(c>='A'&&c<='Z')||c=='_')safe_reason+=c;
    Job next;next.w=q.snapshot_w;next.h=q.snapshot_h;next.path=frames+"/frame-"+std::to_string(now)+"-"+(safe_reason.empty()?"unknown":safe_reason)+".png";
    next.pixels.reserve(next.w*next.h);for(int oy=0;oy<next.h;oy++){int sy=std::min(h-1,oy*h/next.h);for(int ox=0;ox<next.w;ox++){int sx=std::min(w-1,ox*w/next.w);next.pixels.push_back(y[sy*w+sx]);}}
    {std::lock_guard<std::mutex> lock(mutex_);if(pending_)return;job_=std::move(next);pending_=true;last_=now;count_++;}ready_.notify_one();
  }
};

struct IgnoreSigpipe { IgnoreSigpipe(){ signal(SIGPIPE,SIG_IGN); } };
static IgnoreSigpipe ignore_sigpipe;

struct StatusPublisher {
  int listener=-1,client=-1;
  StatusPublisher(){listener=socket(AF_INET,SOCK_STREAM,0);if(listener>=0){int yes=1;setsockopt(listener,SOL_SOCKET,SO_REUSEADDR,&yes,sizeof(yes));fcntl(listener,F_SETFL,fcntl(listener,F_GETFL,0)|O_NONBLOCK);sockaddr_in a{};a.sin_family=AF_INET;a.sin_port=htons(14551);a.sin_addr.s_addr=INADDR_ANY;if(bind(listener,(sockaddr*)&a,sizeof(a))<0||listen(listener,1)<0){close(listener);listener=-1;}}}
  ~StatusPublisher(){if(client>=0)close(client);if(listener>=0)close(listener);}
  void sendLine(const std::string&line){if(listener<0)return;if(client<0)client=accept(listener,nullptr,nullptr);if(client<0)return;std::string out=line+'\n';if(send(client,out.data(),out.size(),MSG_DONTWAIT|MSG_NOSIGNAL)<0&&errno!=EAGAIN&&errno!=EWOULDBLOCK){close(client);client=-1;}}
};

int main(int ac,char**av){
  std::string cp="Config/Camera.yaml",lp="Config/Landing.yaml";
  int rtsp_mode=0;
  for(int i=1;i<ac;i++){
    std::string arg=av[i];
    if(arg=="--camera"&&i+1<ac)cp=av[++i];
    else if(arg=="--config"&&i+1<ac)lp=av[++i];
    else if((arg=="-rtsp"||arg=="--rtsp")&&i+1<ac)rtsp_mode=std::stoi(av[++i]);
    else {std::cerr<<"Unknown or incomplete argument: "<<arg<<"\nUsage: luckfox_landing [--camera FILE] [--config FILE] [-rtsp 0|1|2]\n";return 2;}
  }
  if(rtsp_mode<0||rtsp_mode>2){std::cerr<<"-rtsp must be 0, 1, or 2\n";return 2;}
  try{
    auto m=yaml(lp);Cfg q;
    q.dev=s(m,"camera_device",q.dev);q.uart=s(m,"uart_device",q.uart);q.baud=d(m,"uart_baud",q.baud);
    q.host=s(m,"mavlink_bridge_host",q.host);q.bridge_port=d(m,"mavlink_bridge_port",q.bridge_port);
    q.w=d(m,"width",q.w);q.h=d(m,"height",q.h);
    q.ox=d(m,"camera_offset_x_m",0);q.oy=d(m,"camera_offset_y_m",0);q.oz=d(m,"camera_offset_z_m",0);
    q.maxerr=d(m,"max_reprojection_error_px",2);q.margin=d(m,"min_decision_margin",35);q.ham=d(m,"max_hamming",0);
    q.lost=d(m,"lost_timeout_ms",300);q.target_holdover=d(m,"target_holdover_ms",0);q.hz=d(m,"inference_hz",10);q.min_hz=d(m,"min_inference_hz",6);q.threads=d(m,"apriltag_threads",2);q.decimate=d(m,"quad_decimate",1.0);
    q.range_min=d(m,"vision_range_min_m",d(m,"rangefinder_min_m",.1));q.range_max=d(m,"vision_range_max_m",d(m,"rangefinder_max_m",3));
    q.switch_frames=d(m,"tag_switch_confirm_frames",12);q.filter_alpha=d(m,"landing_filter_alpha",.35);q.match_m=d(m,"tag_handoff_tolerance_m",.05);
    q.single_tag=d(m,"single_tag_mode",1);q.snapshots=d(m,"diagnostic_snapshots",0);q.snapshot_interval=d(m,"diagnostic_snapshot_interval_ms",2000);q.snapshot_limit=d(m,"diagnostic_snapshot_limit",60);q.snapshot_w=d(m,"diagnostic_snapshot_width",160);q.snapshot_h=d(m,"diagnostic_snapshot_height",90);q.min_tag_px=d(m,"min_tag_size_px",12);q.max_xy_jump=d(m,"max_center_jump_m",.15);q.max_z_jump=d(m,"max_range_jump_m",.25);q.max_xy_speed=d(m,"max_center_speed_mps",1.0);q.max_z_speed=d(m,"max_range_speed_mps",1.5);q.medium_below=d(m,"medium_tag_select_below_m",1.5);q.small_below=d(m,"small_tag_select_below_m",.75);q.medium_above=d(m,"medium_tag_release_above_m",1.8);q.small_above=d(m,"small_tag_release_above_m",.95);q.small_fast_alt=d(m,"small_tag_fast_handoff_max_alt_m",.75);q.large_min=d(m,"large_tag_min_range_m",.6);q.large_max=d(m,"large_tag_max_range_m",q.range_max);q.medium_min=d(m,"medium_tag_min_range_m",.4);q.medium_max=d(m,"medium_tag_max_range_m",3.0);q.small_min=d(m,"small_tag_min_range_m",.2);q.small_max=d(m,"small_tag_max_range_m",2.0);q.tier_reset=d(m,"tag_tier_reset_ms",5000);q.min_confidence=d(m,"min_detection_confidence",.35);
    q.guided_hold=d(m,"guided_nogps_tag_hold",0);q.guided_mode=d(m,"guided_nogps_custom_mode",20);q.guided_sysid=d(m,"guided_target_system",1);q.guided_compid=d(m,"guided_target_component",1);q.guided_heartbeat_timeout=d(m,"guided_heartbeat_timeout_ms",2000);q.guided_attitude_timeout=d(m,"guided_attitude_timeout_ms",1000);q.guided_kp=d(m,"guided_hold_kp_rad_per_m",.20);q.guided_deadband=d(m,"guided_hold_deadband_m",.03);q.guided_max_tilt_deg=d(m,"guided_hold_max_tilt_deg",8);q.guided_climb_neutral=d(m,"guided_hold_climb_neutral",.5);
    // Vehicle position now comes from the real GPS.  Keep camera-derived
    // VISION_POSITION_ESTIMATE disabled even when an older deployed config
    // still contains vision_position_estimate_enabled: 1.
    q.vision_position=0;q.vision_attitude_timeout=d(m,"vision_attitude_timeout_ms",500);q.vision_pos_sigma=d(m,"vision_position_sigma_m",.10);q.vision_ang_sigma=d(m,"vision_attitude_sigma_rad",.10);
    q.exposure_min_us=d(m,"exposure_min_us",100);q.exposure_max_us=d(m,"exposure_max_us",2000);q.exposure_gain_min=d(m,"exposure_gain_min",1);q.exposure_gain_max=d(m,"exposure_gain_max",32);
    if(q.hz<1||q.hz>30||q.min_hz<=0||q.min_hz>q.hz||std::abs(q.decimate-1.0)>1e-9)throw std::runtime_error("quad_decimate must be fixed at 1.0");
    if(q.snapshots&&(q.snapshot_interval<1000||q.snapshot_limit<1||q.snapshot_limit>120||q.snapshot_w<80||q.snapshot_w>320||q.snapshot_h<45||q.snapshot_h>180))throw std::runtime_error("invalid diagnostic snapshot configuration");
    if(q.target_holdover<0||q.target_holdover>800||q.target_holdover>=q.lost)throw std::runtime_error("invalid target holdover configuration");
    if(q.guided_hold&&(q.guided_mode!=20||q.guided_sysid<1||q.guided_sysid>255||q.guided_compid<0||q.guided_compid>255||q.guided_heartbeat_timeout<500||q.guided_attitude_timeout<200||q.guided_kp<=0||q.guided_kp>1||q.guided_deadband<0||q.guided_deadband>.20||q.guided_max_tilt_deg<=0||q.guided_max_tilt_deg>12||q.guided_climb_neutral<.45||q.guided_climb_neutral>.55))throw std::runtime_error("invalid GUIDED_NOGPS tag-hold configuration");
    if(q.vision_position&&(q.vision_attitude_timeout<200||q.vision_attitude_timeout>2000||q.vision_pos_sigma<.02||q.vision_pos_sigma>2||q.vision_ang_sigma<.02||q.vision_ang_sigma>1))throw std::runtime_error("invalid vision position estimate configuration");
    if(q.exposure_min_us<20||q.exposure_max_us<q.exposure_min_us||q.exposure_max_us>10000||q.exposure_gain_min<1||q.exposure_gain_max<q.exposure_gain_min||q.exposure_gain_max>64)throw std::runtime_error("invalid fast exposure configuration");
    if(q.switch_frames<2||q.switch_frames>30||q.filter_alpha<=0||q.filter_alpha>1||q.match_m<=0||q.match_m>.10||q.min_tag_px<4||q.max_xy_jump<=q.match_m||q.max_z_jump<=0||q.max_xy_speed<=0||q.max_xy_speed>3||q.max_z_speed<=0||q.max_z_speed>3||q.small_below<=q.range_min||q.medium_below<=q.small_below||q.medium_below>=q.range_max||q.small_above<=q.small_below||q.medium_above<=q.medium_below||q.medium_above>=q.range_max||q.small_fast_alt<q.range_min||q.small_fast_alt>q.medium_below||q.large_min<q.range_min||q.large_max>q.range_max||q.large_min>=q.large_max||q.medium_min<q.range_min||q.medium_min>=q.medium_max||q.small_min<q.range_min||q.small_min>=q.small_max||q.tier_reset<q.lost||q.tier_reset>30000||q.min_confidence<0||q.min_confidence>1)throw std::runtime_error("invalid landing-pad switching configuration");
    const double landing_x=d(m,"landing_target_x_m",.116),landing_y=d(m,"landing_target_y_m",.205);
    std::array<PadTag,3> tags{{
      {"large",(int)d(m,"large_tag_id",0),d(m,"large_tag_x_m",.005),d(m,"large_tag_y_m",.005),d(m,"large_tag_size_m",.200)},
      {"medium",(int)d(m,"medium_tag_id",0),d(m,"medium_tag_x_m",.005),d(m,"medium_tag_y_m",.215),d(m,"medium_tag_size_m",.076)},
      {"small",(int)d(m,"small_tag_id",0),d(m,"small_tag_x_m",.089),d(m,"small_tag_y_m",.215),d(m,"small_tag_size_m",.054)}}};
    if(!q.single_tag&&(tags[0].id==tags[1].id||tags[0].id==tags[2].id||tags[1].id==tags[2].id))throw std::runtime_error("landing tag IDs must be unique");
    Camera cam=camera_yaml(cp,q.w,q.h);Link uart(q.host,q.bridge_port,q.guided_sysid,q.guided_compid);uart.requestInterval(193,4);
    StreamingPipeline pipe(q.w,q.h,q.hz,500,8,8554,"/live","/etc/iqfiles",rtsp_mode,q.exposure_min_us,q.exposure_max_us,q.exposure_gain_min,q.exposure_gain_max);
    const int tag_count=q.single_tag?1:static_cast<int>(tags.size());
    std::cerr<<"Landing started: mode="<<(q.single_tag?"single-tag":"multi-tag")<<" tag_ids="<<tags[0].id;
    if(!q.single_tag)std::cerr<<','<<tags[1].id<<','<<tags[2].id;
    std::cerr<<" rtsp="<<rtsp_mode<<" inference="<<q.w<<"x"<<q.h<<" @ "<<q.hz<<" Hz decimate="<<q.decimate<<" fixed\n";
    StreamingPipeline::Frame frame;auto*tf=tag36h11_create();auto*td=apriltag_detector_create();
    apriltag_detector_add_family(td,tf);td->nthreads=q.threads;td->quad_decimate=q.decimate;td->refine_edges=1;
    int active=-1,pending=-1,pending_count=0,descent_tier=-1;uint32_t previous_fc_mode=uart.custom_mode.load();bool previous_armed=(uart.base_mode.load()&128)!=0;uint64_t seen=0,pending_seen=0;bool lost=false,have_center=false,have_last_target=false;double last_bx=0,last_by=0,last_bz=0;P filtered{},last_center{},pending_center{};std::string switch_state="UNINITIALIZED";Candidate debug_candidate{};SnapshotWriter snapshots;
    uint64_t report_start=usec(),previous_frame=0,last_exposure_report=0;double rate_ema=q.hz;StatusPublisher status;
    signal(SIGINT,sig);signal(SIGTERM,sig);
    while(run){
      if(!pipe.acquire(frame,200))continue;
      debug_candidate=Candidate{};
      uint64_t now=usec();if(previous_frame){double instant=1000000.0/(now-previous_frame);rate_ema=.85*rate_ema+.15*instant;}previous_frame=now;
      std::string tier_reset_reason="none";const uint32_t fc_mode=uart.custom_mode.load();const bool armed=(uart.base_mode.load()&128)!=0;
      if(previous_fc_mode==9&&fc_mode==5){descent_tier=-1;pending=-1;pending_count=0;pending_seen=0;tier_reset_reason="land_to_loiter";}
      if(previous_armed&&!armed){descent_tier=-1;active=-1;pending=-1;pending_count=0;seen=0;pending_seen=0;lost=false;have_center=false;have_last_target=false;tier_reset_reason="disarmed";switch_state="RESET_AFTER_DISARM";}
      previous_fc_mode=fc_mode;previous_armed=armed;
      if(seen&&now-seen>(uint64_t)q.tier_reset*1000)descent_tier=-1;
      if(seen&&now-seen>(uint64_t)q.lost*1000){have_center=false;active=-1;pending=-1;pending_count=0;pending_seen=0;lost=true;switch_state="RESET_AFTER_LOSS";}
      image_u8_t im={q.w,q.h,q.w,frame.y};zarray_t*z=apriltag_detector_detect(td,&im);
      std::vector<Candidate> candidates;std::ostringstream detected_stream;detected_stream<<'[';bool first_detection=true;std::string reject_reason=zarray_size(z)?"no_configured_tag":"no_detection";const double tag_min[3]={q.large_min,q.medium_min,q.small_min},tag_max[3]={q.large_max,q.medium_max,q.small_max};
      for(int n=0;n<zarray_size(z);n++){apriltag_detection_t*x;zarray_get(z,n,&x);double pixels=tagPixels(x);if(!first_detection)detected_stream<<';';first_detection=false;detected_stream<<x->id<<':'<<pixels<<':'<<x->decision_margin<<':'<<x->hamming;bool configured=false;for(int ti=0;ti<tag_count;ti++)if(x->id==tags[ti].id){configured=true;break;}if(!configured){reject_reason="unconfigured_id";continue;}if(x->hamming>q.ham){reject_reason="hamming";continue;}if(x->decision_margin<q.margin){reject_reason="decision_margin";continue;}if(pixels<q.min_tag_px){reject_reason="tag_too_small";continue;}P unit;if(!solvePnP(x,cam,1.0,unit)){reject_reason="pose_failed";continue;}if(unit.err>q.maxerr){reject_reason="reprojection_error";continue;}double margin_score=std::min(1.0,x->decision_margin/(2*q.margin));double error_score=std::max(0.0,1-unit.err/q.maxerr);double size_score=std::min(1.0,pixels/(2*q.min_tag_px));double confidence=(margin_score+error_score+size_score)/3;if(confidence<q.min_confidence){reject_reason="low_confidence";continue;}for(int ti=0;ti<tag_count;ti++){const auto&g=tags[ti];if(x->id!=g.id)continue;P p=unit;p.x*=g.size;p.y*=g.size;p.z*=g.size;Candidate c;c.tag=ti;c.det=n;c.raw=p;c.center=landingCenter(p,g,landing_x,landing_y);c.dx=c.center.x-p.x;c.dy=c.center.y-p.y;c.dz=c.center.z-p.z;c.quality=x->decision_margin;c.pixels=pixels;c.confidence=confidence;if(c.center.z<q.range_min||c.center.z>q.range_max){reject_reason="vision_range";continue;}if(!q.single_tag&&(c.center.z<tag_min[ti]||c.center.z>tag_max[ti])){reject_reason="tag_tier_range";continue;}candidates.push_back(c);reject_reason="none";}}detected_stream<<']';
      // Tags are ordered large -> medium -> small. Select the tier from visual
      // pose Z and never move back to a larger tag during one landing approach.
      // Leaving LAND for LOITER starts a new approach immediately; a long
      // target-free interval remains the fallback reset.
      Candidate preferred,chosen,active_candidate;bool have_preferred=false,have_active_candidate=false,ok=false;
      for(const auto&c:candidates)if(c.tag==active&&(!have_active_candidate||c.confidence>active_candidate.confidence)){active_candidate=c;have_active_candidate=true;}
      double select_z=have_center?last_center.z:0.0;
      if(!have_center&&candidates.size()){select_z=candidates.front().center.z;for(const auto&c:candidates)select_z=std::min(select_z,c.center.z);}
      int desired=select_z<=q.small_below?2:(select_z<=q.medium_below?1:0);
      if(have_center&&active==2)desired=select_z>q.medium_above?0:(select_z>q.small_above?1:2);
      else if(have_center&&active==1)desired=select_z<=q.small_below?2:(select_z>q.medium_above?0:1);
      const int tier_floor=fc_mode==9?descent_tier:-1;desired=std::max(desired,tier_floor);
      for(const auto&c:candidates){
        if(c.tag<tier_floor)continue;
        const int rank=std::abs(c.tag-desired);
        const int best_rank=have_preferred?std::abs(preferred.tag-desired):99;
        if(!have_preferred||rank<best_rank||(rank==best_rank&&c.confidence>preferred.confidence)){preferred=c;have_preferred=true;}
      }
      std::string selection_reason=reject_reason;
      if(have_preferred){
        debug_candidate=preferred;
        if(!have_center){chosen=preferred;ok=true;active=chosen.tag;if(fc_mode==9)descent_tier=std::max(descent_tier,active);pending=-1;pending_count=0;filtered=last_center=chosen.center;have_center=true;switch_state="INITIAL_LOCK";}
        else if(preferred.tag==active){
          const double elapsed=seen?std::min(1.5,(now-seen)/1000000.0):0.0,jump_xy=std::hypot(preferred.center.x-last_center.x,preferred.center.y-last_center.y),jump_z=std::abs(preferred.center.z-last_center.z);
          if(jump_xy<=q.max_xy_jump+q.max_xy_speed*elapsed&&jump_z<=q.max_z_jump+q.max_z_speed*elapsed){chosen=preferred;ok=true;pending=-1;pending_count=0;pending_seen=0;switch_state="STABLE_UNIQUE_ID";}
          else {selection_reason=jump_xy>q.max_xy_jump?"center_jump":"range_jump";switch_state="ACTIVE_JUMP_REJECTED";}
        }else{
          const double elapsed=seen?std::min(1.5,(now-seen)/1000000.0):0.0;
          const double xy_jump_limit=q.max_xy_jump+q.max_xy_speed*elapsed,z_jump_limit=q.max_z_jump+q.max_z_speed*elapsed;
          const bool usable_active=have_active_candidate&&std::hypot(active_candidate.center.x-last_center.x,active_candidate.center.y-last_center.y)<=xy_jump_limit&&std::abs(active_candidate.center.z-last_center.z)<=z_jump_limit;
          const P&reference=usable_active?active_candidate.center:last_center;
          const double agreement_xy=std::hypot(preferred.center.x-reference.x,preferred.center.y-reference.y),agreement_z=std::abs(preferred.center.z-reference.z);
          const double pending_elapsed=pending==preferred.tag&&pending_seen?std::min(1.5,(now-pending_seen)/1000000.0):0.0;
          const bool pending_motion_ok=pending!=preferred.tag||(std::hypot(preferred.center.x-pending_center.x,preferred.center.y-pending_center.y)<=q.max_xy_jump+q.max_xy_speed*pending_elapsed&&std::abs(preferred.center.z-pending_center.z)<=q.max_z_jump+q.max_z_speed*pending_elapsed);
          const double agreement_xy_limit=handoffLimit(q.match_m,q.max_xy_speed,elapsed,usable_active);
          const double agreement_z_limit=handoffLimit(q.max_z_jump,q.max_z_speed,elapsed,usable_active);
          const bool agreement_ok=agreement_xy<=agreement_xy_limit&&agreement_z<=agreement_z_limit;
          const bool fast_small=preferred.tag==2&&preferred.center.z<=q.small_fast_alt&&preferred.confidence>=.75&&preferred.raw.err<=1.0&&agreement_ok&&pending_motion_ok;
          const int required_frames=usable_active?std::min(2,q.switch_frames):q.switch_frames;
          if(agreement_ok&&pending_motion_ok){
            if(pending==preferred.tag)pending_count++;else {pending=preferred.tag;pending_count=1;}
            pending_center=preferred.center;pending_seen=now;switch_state="HANDOFF_PENDING_"+std::to_string(pending_count)+"_OF_"+std::to_string(required_frames);
            if(fast_small||pending_count>=required_frames){chosen=preferred;ok=true;active=chosen.tag;if(fc_mode==9)descent_tier=std::max(descent_tier,active);pending=-1;pending_count=0;pending_seen=0;switch_state=fast_small?"HANDOFF_FAST_SMALL":(usable_active?"HANDOFF_CONFIRMED_OVERLAP":"HANDOFF_CONFIRMED");}
            else if(usable_active){chosen=active_candidate;ok=true;selection_reason="active_during_handoff";}
            else selection_reason="tag_switch_pending";
          }else {pending=-1;pending_count=0;pending_seen=0;selection_reason=agreement_xy>agreement_xy_limit?"handoff_center_mismatch":(agreement_z>agreement_z_limit?"handoff_range_mismatch":"handoff_motion_jump");switch_state="HANDOFF_REJECTED";if(usable_active){chosen=active_candidate;ok=true;}}
        }
      }else switch_state="NO_VALID_TAG";
      int fused_count=0;P measurement=chosen.center;if(ok){double sum_w=0,sx=0,sy=0,sz=0;for(const auto&c:candidates){if(c.tag<tier_floor||std::hypot(c.center.x-chosen.center.x,c.center.y-chosen.center.y)>q.match_m||std::abs(c.center.z-chosen.center.z)>q.max_z_jump)continue;const double w=c.confidence*c.pixels/std::max(.1,c.raw.err);sum_w+=w;sx+=w*c.center.x;sy+=w*c.center.y;sz+=w*c.center.z;fused_count++;}if(sum_w>0){measurement=chosen.center;measurement.x=sx/sum_w;measurement.y=sy/sum_w;measurement.z=sz/sum_w;}last_center=measurement;if(switch_state=="INITIAL_LOCK")filtered=measurement;else{filtered.x+=(measurement.x-filtered.x)*q.filter_alpha;filtered.y+=(measurement.y-filtered.y)*q.filter_alpha;filtered.z+=(measurement.z-filtered.z)*q.filter_alpha;}}
      P best=filtered;double bx=0,by=0,bz=0,angle_x=0,angle_y=0,hold_roll=0,hold_pitch=0;bool sent=false,vision_sent=false,hold_has_target=false;std::string send_reason=selection_reason,hold_state="DISABLED";
      // Installed camera: image-up is body-forward and image-right is
      // body-right. MAV_FRAME_BODY_FRD uses +X forward, +Y right, +Z down.
      if(ok){seen=now;lost=false;const double cx=best.x,cy=best.y,cz=best.z;bx=q.ox-cy;by=q.oy+cx;bz=q.oz+cz;angle_x=std::atan2(by,bz);angle_y=std::atan2(bx,bz);if(std::isfinite(bx)&&std::isfinite(by)&&std::isfinite(bz)&&bz>=q.range_min&&bz<=q.range_max){uart.distance(bz,q.range_min,q.range_max);uart.landing(bx,by,bz,true);if(q.vision_position)vision_sent=uart.vision(bx,by,bz,q.vision_attitude_timeout,q.vision_pos_sigma,q.vision_ang_sigma);last_bx=bx;last_by=by;last_bz=bz;have_last_target=true;sent=true;send_reason="sent";}else send_reason="body_transform_invalid";}
      else if(have_last_target&&seen&&now-seen<=(uint64_t)q.target_holdover*1000){bx=last_bx;by=last_by;bz=last_bz;angle_x=std::atan2(by,bz);angle_y=std::atan2(bx,bz);uart.distance(bz,q.range_min,q.range_max);uart.landing(bx,by,bz,true);sent=true;send_reason="holdover";}
      else if(seen&&now-seen>(uint64_t)q.lost*1000&&!lost){
        // Do not send a synthetic LANDING_TARGET when the tag is lost.
        // ArduPilot treats position_valid=0 as an angle-only observation, not
        // as a target-invalid marker.  Silence lets its PrecLand timeout clear
        // the estimator and report "PrecLand: Target Lost" safely.
        lost=true;
      }
      if(q.guided_hold){
        if(uart.guidedReady(q.guided_mode,q.guided_heartbeat_timeout,q.guided_attitude_timeout)){
          hold_state="LEVEL_NO_TARGET";
          if(sent&&ok){
            const double limit=q.guided_max_tilt_deg*M_PI/180.0;
            const double forward=std::abs(bx)<=q.guided_deadband?0:bx-std::copysign(q.guided_deadband,bx);
            const double right=std::abs(by)<=q.guided_deadband?0:by-std::copysign(q.guided_deadband,by);
            hold_roll=std::clamp(q.guided_kp*right,-limit,limit);
            hold_pitch=std::clamp(-q.guided_kp*forward,-limit,limit);
            hold_has_target=true;hold_state="TAG_CORRECTION";
          }
          uart.attitude(hold_roll,hold_pitch,uart.yaw_rad.load(),q.guided_climb_neutral);
        }else hold_state="INHIBITED_MODE_ARM_OR_TELEMETRY";
      }
      if(rtsp_mode==2&&ok&&chosen.det>=0){apriltag_detection_t*tracked;zarray_get(z,chosen.det,&tracked);drawTrackedTag(frame.y,q.w,q.h,tracked);}
      // The encoder may immediately recycle the DMA-backed frame in publish(),
      // so copy the diagnostic pixels while the capture buffer is still ours.
      snapshots.submit(frame.y,q.w,q.h,now,send_reason,q);
      if(!pipe.publish(frame))std::cerr<<"VENC dropped frame\n";
      apriltag_detections_destroy(z);
      uint64_t report_now=usec();
      if(report_now-last_exposure_report>=1000000){double exposure_us=0,exposure_gain=0,mean_luma=0;bool converged=false;if(pipe.exposure(exposure_us,exposure_gain,mean_luma,converged))std::cerr<<"PL_EXPOSURE time_us="<<exposure_us<<" gain="<<exposure_gain<<" mean_luma="<<mean_luma<<" converged="<<(converged?"YES":"NO")<<'\n';last_exposure_report=report_now;}
      const Candidate&logc=ok?chosen:debug_candidate;int log_id=logc.tag>=0?tags[logc.tag].id:-1;
      std::ostringstream candidate_stream;candidate_stream<<'[';for(size_t ci=0;ci<candidates.size();ci++){const auto&c=candidates[ci];if(ci)candidate_stream<<';';candidate_stream<<tags[c.tag].id<<':'<<c.pixels<<':'<<c.confidence<<':'<<c.raw.err<<":("<<c.center.x<<','<<c.center.y<<','<<c.center.z<<')';}candidate_stream<<']';
      const uint16_t ekf_flags=uart.ekf_flags.load();const bool ekf_pos_rel=(ekf_flags&8)!=0,ekf_const_pos=(ekf_flags&128)!=0;const uint64_t heartbeat_stamp=uart.heartbeat_us.load(),attitude_stamp=uart.attitude_us.load(),ekf_stamp=uart.ekf_us.load();const auto age_ms=[&](uint64_t stamp){return !stamp?UINT64_C(999999):(stamp>=now?UINT64_C(0):(now-stamp)/1000);};
      std::ostringstream frame_log;frame_log<<"PL_FRAME ts_us="<<now<<" detections="<<detected_stream.str()<<" candidates="<<candidate_stream.str()<<" tag_id="<<log_id<<" tag="<<(logc.tag>=0?tags[logc.tag].name:"none")<<" fused="<<fused_count<<" px="<<logc.pixels<<" raw_cam_m=("<<logc.raw.x<<','<<logc.raw.y<<','<<logc.raw.z<<") offset_cam_m=("<<logc.dx<<','<<logc.dy<<','<<logc.dz<<") center_cam_m=("<<(ok?best.x:logc.center.x)<<','<<(ok?best.y:logc.center.y)<<','<<(ok?best.z:logc.center.z)<<") body_frd_m=("<<bx<<','<<by<<','<<bz<<") angle_x="<<angle_x<<" angle_y="<<angle_y<<" confidence="<<logc.confidence<<" reproj_px="<<logc.raw.err<<" switch=\""<<switch_state<<"\" tier_reset="<<tier_reset_reason<<" mav="<<(sent?"SENT":"SUPPRESSED")<<" vision="<<(vision_sent?"SENT":(q.vision_position?"SUPPRESSED":"DISABLED"))<<" vision_local_ned_m=("<<uart.vision_n.load()<<','<<uart.vision_e.load()<<','<<uart.vision_d.load()<<") fc_mode="<<fc_mode<<" armed="<<(armed?"YES":"NO")<<" heartbeat_age_ms="<<age_ms(heartbeat_stamp)<<" attitude_age_ms="<<age_ms(attitude_stamp)<<" ekf_age_ms="<<age_ms(ekf_stamp)<<" ekf_flags="<<ekf_flags<<" ekf_pos_horiz_rel="<<(ekf_pos_rel?"YES":"NO")<<" ekf_const_pos="<<(ekf_const_pos?"YES":"NO")<<" reason="<<send_reason<<" guided_hold="<<hold_state<<" hold_target="<<(hold_has_target?"YES":"NO")<<" hold_roll_rad="<<hold_roll<<" hold_pitch_rad="<<hold_pitch;std::cerr<<frame_log.str()<<'\n';status.sendLine(frame_log.str());
      if(report_now-report_start>=300000){char line[512];const char*detected=debug_candidate.tag>=0?tags[debug_candidate.tag].name:"none";const char*active_name=active>=0?tags[active].name:"none";snprintf(line,sizeof(line),"PL_STATUS TAG=%s candidate=%s active=%s(%.3fm) target_offset_cam=(%+.3f,%+.3f,%+.3f)m switch=%s infer=%.2fHz decimate=%.2f X=%.3f Y=%.3f Z=%.3f MAV=%s",ok?"FOUND":"LOST",detected,active_name,active>=0?tags[active].size:0.0,debug_candidate.dx,debug_candidate.dy,debug_candidate.dz,switch_state.c_str(),rate_ema,td->quad_decimate,sent?bx:0.0,sent?by:0.0,sent?bz:0.0,sent?"VALID":"INVALID");status.sendLine(line);report_start=report_now;}
    }
    pipe.release(frame);apriltag_detector_destroy(td);tag36h11_destroy(tf);
  }catch(const std::exception&e){std::cerr<<"luckfox_landing: "<<e.what()<<"\n";return 1;}
  return 0;
}
