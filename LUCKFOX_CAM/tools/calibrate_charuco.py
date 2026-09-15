#!/usr/bin/env python3
import argparse, pathlib, sys, time
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
    detector=ar.CharucoDetector(board); cap=cv2.VideoCapture(a.device,cv2.CAP_V4L2)
    cap.set(cv2.CAP_PROP_FRAME_WIDTH,a.width); cap.set(cv2.CAP_PROP_FRAME_HEIGHT,a.height)
    corners=[]; ids=[]; last=None; last_t=0
    while cap.isOpened() and len(corners)<a.samples:
        ok,frame=cap.read()
        if not ok: continue
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
    cap.release();cv2.destroyAllWindows()
    if len(corners)<12: sys.exit("Calibration rejected: fewer than 12 usable views")
    err,K,D,rv,tv=ar.calibrateCameraCharuco(corners,ids,board,(a.width,a.height),None,None)
    if err>0.5: sys.exit(f"Calibration rejected: reprojection error {err:.3f} px > 0.5 px")
    out=pathlib.Path(a.output);out.parent.mkdir(parents=True,exist_ok=True)
    fs=cv2.FileStorage(str(out),cv2.FILE_STORAGE_WRITE);fs.write("image_width",a.width);fs.write("image_height",a.height)
    fs.write("camera_matrix",K);fs.write("distortion_coefficients",D);fs.write("reprojection_error",float(err));fs.release()
    print(f"Saved {out}: reprojection error {err:.3f} px")
if __name__=="__main__": main()
