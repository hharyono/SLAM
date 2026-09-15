#!/usr/bin/env python3
import argparse, os, pathlib, sys, threading, time
# Avoid loading an incompatible Qt plugin inherited from Conda/desktop shells.
os.environ.pop("QT_PLUGIN_PATH",None)
os.environ.pop("QT_QPA_PLATFORM_PLUGIN_PATH",None)
try:
    import cv2
    import numpy as np
except ImportError:
    sys.exit("Calibration requires: pip install opencv-contrib-python numpy")

def main():
    p=argparse.ArgumentParser(description="ChArUco camera calibration with preview and automatic capture")
    p.add_argument("--device",default="/dev/video11"); p.add_argument("--output",default="Config/Camera.yaml")
    p.add_argument("--width",type=int,default=1280); p.add_argument("--height",type=int,default=720)
    p.add_argument("--squares-x",type=int,default=7); p.add_argument("--squares-y",type=int,default=5)
    p.add_argument("--square-mm",type=float,default=30); p.add_argument("--marker-mm",type=float,default=22)
    p.add_argument("--samples",type=int,default=25); a=p.parse_args()
    ar=cv2.aruco; dictionary=ar.getPredefinedDictionary(ar.DICT_4X4_50)
    board=ar.CharucoBoard((a.squares_x,a.squares_y),a.square_mm/1000,a.marker_mm/1000,dictionary)
    detector_params=ar.DetectorParameters()
    detector_params.cornerRefinementMethod=ar.CORNER_REFINE_SUBPIX
    detector_params.cornerRefinementWinSize=5
    detector_params.cornerRefinementMaxIterations=50
    detector_params.cornerRefinementMinAccuracy=0.01
    detector=ar.CharucoDetector(board,ar.CharucoParameters(),detector_params)
    # Device nodes use V4L2; network URLs let OpenCV select FFmpeg/GStreamer.
    if "://" in a.device:
        os.environ.setdefault(
            "OPENCV_FFMPEG_CAPTURE_OPTIONS",
            "rtsp_transport;tcp|fflags;nobuffer")
    cap=(cv2.VideoCapture(a.device,cv2.CAP_V4L2)
         if not "://" in a.device else cv2.VideoCapture(
             a.device,cv2.CAP_FFMPEG,
             [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC,5000,
              cv2.CAP_PROP_READ_TIMEOUT_MSEC,2000]))
    cap.set(cv2.CAP_PROP_FRAME_WIDTH,a.width); cap.set(cv2.CAP_PROP_FRAME_HEIGHT,a.height)
    cap.set(cv2.CAP_PROP_BUFFERSIZE,1)
    if not cap.isOpened():
        sys.exit(f"Cannot open camera source: {a.device}")
    # Continuously drain RTSP in a reader thread. Calibration consumes only the
    # newest frame instead of accumulating seconds of stale decoded frames.
    latest={"frame":None,"seq":0,"stop":False}; lock=threading.Lock()
    def read_latest():
        while not latest["stop"]:
            ok,frame=cap.read()
            if not ok:
                time.sleep(0.005); continue
            with lock:
                latest["frame"]=frame; latest["seq"]+=1
    reader=threading.Thread(target=read_latest,daemon=True); reader.start()
    corners=[]; ids=[]; last=None; last_t=0
    seen=0
    while cap.isOpened() and len(corners)<a.samples:
        with lock:
            seq=latest["seq"]
            frame=None if seq==seen or latest["frame"] is None else latest["frame"].copy()
        if frame is None:
            time.sleep(0.002); continue
        seen=seq
        cc,ci,mc,mi=detector.detectBoard(frame)
        if ci is not None and len(ci)>=8:
            center=np.mean(cc.reshape(-1,2),axis=0)
            signature=np.r_[center, np.std(cc.reshape(-1,2),axis=0)]
            diverse=last is None or np.linalg.norm(signature-last)>35
            if diverse and time.monotonic()-last_t>0.45:
                corners.append(cc.copy());ids.append(ci.copy());last=signature;last_t=time.monotonic()
            ar.drawDetectedCornersCharuco(frame,cc,ci)
        cv2.putText(frame,f"AUTO {len(corners)}/{a.samples}  ESC cancel",(20,35),0,0.8,(0,255,0),2)
        cv2.imshow("LuckfoxCam ChArUco Calibration",frame)
        if cv2.waitKey(1)&255==27: break
    # Never release VideoCapture while another thread is inside cap.read();
    # doing so can corrupt FFmpeg/OpenCV allocator state.
    latest["stop"]=True; reader.join(timeout=3)
    if reader.is_alive():
        sys.exit("Camera reader did not stop within 3 seconds")
    cap.release(); cv2.destroyAllWindows()
    if len(corners)<12: sys.exit("Calibration rejected: fewer than 12 usable views")
    # Remove individual bad views and solve again instead of allowing one blurred
    # or reflection-corrupted capture to invalidate an otherwise good dataset.
    keep=list(range(len(corners)))
    while True:
        selected_corners=[corners[i] for i in keep]; selected_ids=[ids[i] for i in keep]
        result=ar.calibrateCameraCharucoExtended(
            selected_corners,selected_ids,board,(a.width,a.height),None,None)
        err,K,D,rv,tv,_,_,per_view=result
        if err<=0.5 or len(keep)<=12:
            break
        worst=int(np.argmax(np.asarray(per_view).reshape(-1)))
        dropped=keep.pop(worst)
        print(f"Rejecting view {dropped+1}: reprojection error "
              f"{float(np.asarray(per_view).reshape(-1)[worst]):.3f} px")
    if err>0.5:
        sys.exit(f"Calibration rejected after outlier filtering: reprojection error "
                 f"{err:.3f} px > 0.5 px ({len(keep)} usable views)")
    out=pathlib.Path(a.output);out.parent.mkdir(parents=True,exist_ok=True)
    fs=cv2.FileStorage(str(out),cv2.FILE_STORAGE_WRITE);fs.write("image_width",a.width);fs.write("image_height",a.height)
    fs.write("camera_matrix",K);fs.write("distortion_coefficients",D);fs.write("reprojection_error",float(err));fs.release()
    print(f"Saved {out}: reprojection error {err:.3f} px, "
          f"used {len(keep)}/{len(corners)} views")
if __name__=="__main__": main()
