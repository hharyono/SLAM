#include "streaming_pipeline.hpp"
#include <cstdio>
#include <cstring>
#include <stdexcept>

StreamingPipeline::StreamingPipeline(int w,int h,int fps,int bitrate,int gop,int port,const std::string&path,const std::string&iq,int rtsp_mode):width_(w),height_(h),transmit_(rtsp_mode!=0){
 if(SAMPLE_COMM_ISP_Init(0,RK_AIQ_WORKING_MODE_NORMAL,RK_FALSE,iq.c_str())!=RK_SUCCESS||SAMPLE_COMM_ISP_Run(0)!=RK_SUCCESS)throw std::runtime_error("ISP init failed");isp_=true;
 if(RK_MPI_SYS_Init()!=RK_SUCCESS)throw std::runtime_error("MPI init failed");sys_=true;
 vi_.u32Width=w;vi_.u32Height=h;vi_.s32DevId=0;vi_.u32PipeId=0;vi_.s32ChnId=0;vi_.stChnAttr.stIspOpt.stMaxSize.u32Width=w;vi_.stChnAttr.stIspOpt.stMaxSize.u32Height=h;vi_.stChnAttr.stIspOpt.u32BufCount=2;vi_.stChnAttr.stIspOpt.enMemoryType=VI_V4L2_MEMORY_TYPE_DMABUF;vi_.stChnAttr.u32Depth=1;vi_.stChnAttr.enPixelFormat=RK_FMT_YUV420SP;vi_.stChnAttr.enCompressMode=COMPRESS_MODE_NONE;vi_.stChnAttr.stFrameRate.s32SrcFrameRate=30;vi_.stChnAttr.stFrameRate.s32DstFrameRate=fps;if(SAMPLE_COMM_VI_CreateChn(&vi_)!=RK_SUCCESS)throw std::runtime_error("VI init failed");vi_ok_=true;
 if(!transmit_)return;
 rtsp_=create_rtsp_demo(port);if(!rtsp_||(session_=rtsp_new_session(rtsp_,path.c_str()))==nullptr)throw std::runtime_error("RTSP init failed");rtsp_set_video(session_,RTSP_CODEC_ID_VIDEO_H264,nullptr,0);rtsp_sync_video_ts(session_,rtsp_get_reltime(),rtsp_get_ntptime());
 venc_.s32ChnId=0;venc_.u32Width=w;venc_.u32Height=h;venc_.u32Fps=fps;venc_.u32Gop=gop;venc_.u32BitRate=bitrate;venc_.u32BuffSize=w*h*3/2;venc_.enCodecType=RK_CODEC_TYPE_H264;venc_.enRcMode=VENC_RC_MODE_H264CBR;venc_.enPixelFormat=RK_FMT_YUV420SP;venc_.stChnAttr.stVencAttr.u32Profile=66;venc_.stChnAttr.stGopAttr.enGopMode=VENC_GOPMODE_NORMALP;if(SAMPLE_COMM_VENC_CreateChn(&venc_)!=RK_SUCCESS)throw std::runtime_error("VENC init failed");venc_ok_=true;
 source_={RK_ID_VI,0,0};destination_={RK_ID_VENC,0,0};
 venc_.stFrame.pstPack=static_cast<VENC_PACK_S*>(calloc(1,sizeof(VENC_PACK_S)));if(!venc_.stFrame.pstPack)throw std::runtime_error("VENC pack allocation failed");if(pthread_create(&venc_.getStreamThread,nullptr,streamEntry,this)!=0)throw std::runtime_error("stream thread failed");
}
StreamingPipeline::~StreamingPipeline(){cleanup();}
void* StreamingPipeline::streamEntry(void*a){static_cast<StreamingPipeline*>(a)->streamLoop();return nullptr;}
void StreamingPipeline::streamLoop(){while(streaming_){if(RK_MPI_VENC_GetStream(venc_.s32ChnId,&venc_.stFrame,500)==RK_SUCCESS){auto*d=static_cast<const uint8_t*>(RK_MPI_MB_Handle2VirAddr(venc_.stFrame.pstPack->pMbBlk));rtsp_tx_video(session_,d,venc_.stFrame.pstPack->u32Len,venc_.stFrame.pstPack->u64PTS);rtsp_do_event(rtsp_);RK_MPI_VENC_ReleaseStream(venc_.s32ChnId,&venc_.stFrame);}}}
bool StreamingPipeline::acquire(Frame&f,int ms){if(f.held)release(f);if(RK_MPI_VI_GetChnFrame(0,0,&f.info,ms)!=RK_SUCCESS)return false;f.y=static_cast<uint8_t*>(RK_MPI_MB_Handle2VirAddr(f.info.stVFrame.pMbBlk));f.held=f.y;return f.held;}
void StreamingPipeline::release(Frame&f){if(f.held)RK_MPI_VI_ReleaseChnFrame(0,0,&f.info);f={};}
bool StreamingPipeline::publish(Frame&f,int ms){if(!f.held)return false;if(!transmit_){release(f);return true;}bool ok=RK_MPI_VENC_SendFrame(venc_.s32ChnId,&f.info,ms)==RK_SUCCESS;release(f);return ok;}
void StreamingPipeline::cleanup(){streaming_=false;if(venc_ok_&&venc_.getStreamThread)pthread_join(venc_.getStreamThread,nullptr);if(bound_)SAMPLE_COMM_UnBind(&source_,&destination_);if(venc_ok_)SAMPLE_COMM_VENC_DestroyChn(&venc_);if(vi_ok_)SAMPLE_COMM_VI_DestroyChn(&vi_);if(rtsp_)rtsp_del_demo(rtsp_);if(sys_)RK_MPI_SYS_Exit();if(isp_)SAMPLE_COMM_ISP_Stop(0);}
