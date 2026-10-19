const { app, nativeImage, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
// PNG/JPEG use native decoding; Chromium also validates WebP pixel data locally.
app.setPath('userData', path.join(path.dirname(process.argv[3]), 'chromium'));
app.disableHardwareAcceleration();
function alphaOf(bitmap, width, height) {
  let min = 255, max = 0, left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const alpha = bitmap[(y * width + x) * 4 + 3];
    if (alpha < min) min = alpha;
    if (alpha > max) max = alpha;
    if (alpha > 16) {
      if (x < left) left = x;
      if (y < top) top = y;
      if (x > right) right = x;
      if (y > bottom) bottom = y;
    }
  }
  if (right < 0) return { min, max, bounds: { x: 0, y: 0, width, height } };
  return { min, max, bounds: { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } };
}
function finish(result, code) {
  fs.writeFileSync(process.argv[3], JSON.stringify(result));
  app.exit(code);
}
async function inspect() {
  const image = nativeImage.createFromPath(path.resolve(process.argv[2]));
  let size;
  let alpha;
  if (!image.isEmpty()) {
    size = image.getSize();
    const bitmap = image.toBitmap();
    if (bitmap.length !== size.width * size.height * 4) throw Error('图片像素解码不完整');
    alpha = alphaOf(bitmap, size.width, size.height);
  } else {
    // NativeImage on Windows does not decode WebP. Keep the supported Chromium
    // decoder, but avoid the former offscreen/debugger/navigation handshake.
    await app.whenReady();
    const window = new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false,sandbox:true,nodeIntegration:false,contextIsolation:true}});
    await window.loadURL('data:text/html,<meta charset="utf-8">');
    const data = fs.readFileSync(process.argv[2]).toString('base64');
    size = await window.webContents.executeJavaScript(`(async()=>{
      const bytes=Uint8Array.from(atob(${JSON.stringify(data)}),c=>c.charCodeAt(0));
      const image=await createImageBitmap(new Blob([bytes]));
      const {width,height}=image;
      if(!width||!height||width>16384||height>16384)throw Error('图片尺寸无效或超限');
      const canvas=new OffscreenCanvas(width,height),context=canvas.getContext('2d');
      context.drawImage(image,0,0);
      const pixels=context.getImageData(0,0,width,height).data;image.close();
      let min=255,max=0,left=width,top=height,right=-1,bottom=-1;
      for(let y=0;y<height;y++)for(let x=0;x<width;x++){const a=pixels[(y*width+x)*4+3];if(a<min)min=a;if(a>max)max=a;if(a>16){if(x<left)left=x;if(y<top)top=y;if(x>right)right=x;if(y>bottom)bottom=y;}}
      return {width,height,alpha:{min,max,bounds:right<0?{x:0,y:0,width,height}:{x:left,y:top,width:right-left+1,height:bottom-top+1}}};
    })()`);
    alpha = size.alpha;
    window.destroy();
  }
  if (!size.width || !size.height || size.width > 16384 || size.height > 16384) throw Error('图片尺寸无效或超限');
  finish({size:{width:size.width,height:size.height},alpha},0);
}
inspect().then(()=>{},error=>finish({error:error.message},1));
