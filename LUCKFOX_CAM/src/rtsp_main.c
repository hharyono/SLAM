#include <errno.h>
#include <getopt.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "rtsp_demo.h"
#include "sample_comm.h"

static volatile sig_atomic_t g_running = 1;
static rtsp_demo_handle g_rtsp = NULL;
static rtsp_session_handle g_session = NULL;

typedef struct {
  unsigned width;
  unsigned height;
  unsigned fps;
  unsigned bitrate;
  unsigned port;
  const char *path;
  const char *iq_dir;
} Config;

static void on_signal(int sig) {
  (void)sig;
  g_running = 0;
}

static void *stream_thread(void *arg) {
  SAMPLE_VENC_CTX_S *venc = (SAMPLE_VENC_CTX_S *)arg;
  while (g_running) {
    if (RK_MPI_VENC_GetStream(venc->s32ChnId, &venc->stFrame, 1000) == RK_SUCCESS) {
      void *data = RK_MPI_MB_Handle2VirAddr(venc->stFrame.pstPack->pMbBlk);
      rtsp_tx_video(g_session, data, venc->stFrame.pstPack->u32Len,
                    venc->stFrame.pstPack->u64PTS);
      rtsp_do_event(g_rtsp);
      RK_MPI_VENC_ReleaseStream(venc->s32ChnId, &venc->stFrame);
    }
  }
  return NULL;
}

static unsigned number(const char *text, const char *name) {
  char *end = NULL;
  unsigned long value = strtoul(text, &end, 10);
  if (!text[0] || !end || *end || value == 0 || value > 10000000UL) {
    fprintf(stderr, "invalid %s: %s\n", name, text);
    exit(2);
  }
  return (unsigned)value;
}

static void usage(const char *name) {
  printf("Usage: %s [--width 1280] [--height 720] [--fps 25] "
         "[--bitrate 2500] [--port 8554] [--path /live] "
         "[--iq-dir /etc/iqfiles]\n", name);
}

int main(int argc, char **argv) {
  Config cfg = {1280, 720, 25, 2500, 8554, "/live", "/etc/iqfiles"};
  static const struct option options[] = {
      {"width", required_argument, NULL, 'w'},
      {"height", required_argument, NULL, 'h'},
      {"fps", required_argument, NULL, 'f'},
      {"bitrate", required_argument, NULL, 'b'},
      {"port", required_argument, NULL, 'p'},
      {"path", required_argument, NULL, 's'},
      {"iq-dir", required_argument, NULL, 'a'},
      {"help", no_argument, NULL, '?'},
      {NULL, 0, NULL, 0}};
  int opt;
  while ((opt = getopt_long(argc, argv, "w:h:f:b:p:s:a:?", options, NULL)) != -1) {
    switch (opt) {
      case 'w': cfg.width = number(optarg, "width"); break;
      case 'h': cfg.height = number(optarg, "height"); break;
      case 'f': cfg.fps = number(optarg, "fps"); break;
      case 'b': cfg.bitrate = number(optarg, "bitrate"); break;
      case 'p': cfg.port = number(optarg, "port"); break;
      case 's': cfg.path = optarg; break;
      case 'a': cfg.iq_dir = optarg; break;
      default: usage(argv[0]); return opt == '?' ? 0 : 2;
    }
  }
  if (cfg.port > 65535 || cfg.path[0] != '/') {
    fprintf(stderr, "invalid RTSP port or path\n");
    return 2;
  }

  signal(SIGINT, on_signal);
  signal(SIGTERM, on_signal);
  signal(SIGPIPE, SIG_IGN);

  SAMPLE_VI_CTX_S vi;
  SAMPLE_VENC_CTX_S venc;
  memset(&vi, 0, sizeof(vi));
  memset(&venc, 0, sizeof(venc));
  int isp_started = 0, mpi_started = 0, vi_started = 0, venc_started = 0, bound = 0;
  int result = 1;
  MPP_CHN_S source = {RK_ID_VI, 0, 0};
  MPP_CHN_S destination = {RK_ID_VENC, 0, 0};

  if (SAMPLE_COMM_ISP_Init(0, RK_AIQ_WORKING_MODE_NORMAL, RK_FALSE, cfg.iq_dir) != RK_SUCCESS ||
      SAMPLE_COMM_ISP_Run(0) != RK_SUCCESS) {
    fprintf(stderr, "ISP initialization failed; check SC3336 IQ file and driver\n");
    goto cleanup;
  }
  isp_started = 1;
  if (RK_MPI_SYS_Init() != RK_SUCCESS) {
    fprintf(stderr, "RK MPI initialization failed\n");
    goto cleanup;
  }
  mpi_started = 1;

  g_rtsp = create_rtsp_demo((int)cfg.port);
  if (!g_rtsp || !(g_session = rtsp_new_session(g_rtsp, cfg.path))) {
    fprintf(stderr, "RTSP initialization failed on port %u\n", cfg.port);
    goto cleanup;
  }
  rtsp_set_video(g_session, RTSP_CODEC_ID_VIDEO_H264, NULL, 0);
  rtsp_sync_video_ts(g_session, rtsp_get_reltime(), rtsp_get_ntptime());

  vi.u32Width = cfg.width;
  vi.u32Height = cfg.height;
  vi.s32DevId = 0;
  vi.u32PipeId = 0;
  vi.s32ChnId = 0;
  vi.stChnAttr.stIspOpt.stMaxSize.u32Width = cfg.width;
  vi.stChnAttr.stIspOpt.stMaxSize.u32Height = cfg.height;
  vi.stChnAttr.stIspOpt.u32BufCount = 3;
  vi.stChnAttr.stIspOpt.enMemoryType = VI_V4L2_MEMORY_TYPE_DMABUF;
  vi.stChnAttr.u32Depth = 1;
  vi.stChnAttr.enPixelFormat = RK_FMT_YUV420SP;
  vi.stChnAttr.enCompressMode = COMPRESS_MODE_NONE;
  vi.stChnAttr.stFrameRate.s32SrcFrameRate = -1;
  vi.stChnAttr.stFrameRate.s32DstFrameRate = -1;
  if (SAMPLE_COMM_VI_CreateChn(&vi) != RK_SUCCESS) {
    fprintf(stderr, "VI channel initialization failed\n");
    goto cleanup;
  }
  vi_started = 1;

  venc.s32ChnId = 0;
  venc.u32Width = cfg.width;
  venc.u32Height = cfg.height;
  venc.u32Fps = cfg.fps;
  venc.u32Gop = cfg.fps;
  venc.u32BitRate = cfg.bitrate;
  venc.u32BuffSize = cfg.width * cfg.height * 3 / 2;
  venc.enCodecType = RK_CODEC_TYPE_H264;
  venc.enRcMode = VENC_RC_MODE_H264CBR;
  venc.enPixelFormat = RK_FMT_YUV420SP;
  venc.stChnAttr.stVencAttr.u32Profile = 66;
  venc.stChnAttr.stGopAttr.enGopMode = VENC_GOPMODE_NORMALP;
  venc.getStreamCbFunc = stream_thread;
  if (SAMPLE_COMM_VENC_CreateChn(&venc) != RK_SUCCESS) {
    fprintf(stderr, "H.264 VENC initialization failed\n");
    goto cleanup;
  }
  venc_started = 1;
  if (SAMPLE_COMM_Bind(&source, &destination) != RK_SUCCESS) {
    fprintf(stderr, "VI to VENC bind failed\n");
    goto cleanup;
  }
  bound = 1;
  fprintf(stderr, "stream_started url=rtsp://0.0.0.0:%u%s codec=H264 size=%ux%u fps=%u bitrate_kbps=%u\n",
          cfg.port, cfg.path, cfg.width, cfg.height, cfg.fps, cfg.bitrate);
  /* Service RTSP control traffic even before the first encoded frame arrives. */
  while (g_running) {
    rtsp_do_event(g_rtsp);
    usleep(10000);
  }
  result = 0;

cleanup:
  g_running = 0;
  if (bound) SAMPLE_COMM_UnBind(&source, &destination);
  if (venc_started) {
    pthread_join(venc.getStreamThread, NULL);
    SAMPLE_COMM_VENC_DestroyChn(&venc);
  }
  if (vi_started) SAMPLE_COMM_VI_DestroyChn(&vi);
  if (g_rtsp) rtsp_del_demo(g_rtsp);
  if (mpi_started) RK_MPI_SYS_Exit();
  if (isp_started) SAMPLE_COMM_ISP_Stop(0);
  return result;
}
