const { app, nativeImage, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const source = path.resolve(process.argv[2]);
const outDir = path.resolve(process.argv[3]);
app.setPath('userData', path.join(os.tmpdir(), 'allmind-icon-chromium'));
app.disableHardwareAcceleration();
setTimeout(() => { console.error('图标派生超时'); app.exit(1); }, 20000).unref();

function pngIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(16 * images.length);
  const parts = [header, entries];
  let offset = header.length + entries.length;
  images.forEach((image, index) => {
    const entry = entries.subarray(index * 16, index * 16 + 16);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 0);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    parts.push(image.png);
    offset += image.png.length;
  });
  return Buffer.concat(parts);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, sandbox: true, nodeIntegration: false, contextIsolation: true } });
  await window.loadURL('data:text/html,<meta charset="utf-8">');
  const encoded = fs.readFileSync(source).toString('base64');
  const decoded = await window.webContents.executeJavaScript(`(async()=>{
    const bytes=Uint8Array.from(atob(${JSON.stringify(encoded)}),c=>c.charCodeAt(0));
    const image=await createImageBitmap(new Blob([bytes],{type:'image/webp'}));
    const full=new OffscreenCanvas(image.width,image.height),fullContext=full.getContext('2d');
    fullContext.drawImage(image,0,0);
    const pixels=fullContext.getImageData(0,0,image.width,image.height).data;
    const width=image.width,height=image.height;
    let min=255,max=0,left=width,top=height,right=-1,bottom=-1;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){const a=pixels[(y*width+x)*4+3];if(a<min)min=a;if(a>max)max=a;if(a>16){if(x<left)left=x;if(y<top)top=y;if(x>right)right=x;if(y>bottom)bottom=y;}}
    const crop={x:left,y:top,width:right-left+1,height:bottom-top+1};
    const sizes=[16,32,48,256];
    const images=[];
    for(const size of sizes){
      const canvas=new OffscreenCanvas(size,size),context=canvas.getContext('2d');
      context.clearRect(0,0,size,size);
      const side=Math.max(crop.width,crop.height);
      const originX=crop.x-Math.floor((side-crop.width)/2),originY=crop.y-Math.floor((side-crop.height)/2);
      context.drawImage(image,originX,originY,side,side,0,0,size,size);
      const sample=context.getImageData(0,0,size,size).data;
      let smin=255,smax=0;
      for(let i=3;i<sample.length;i+=4){if(sample[i]<smin)smin=sample[i];if(sample[i]>smax)smax=sample[i];}
      const blob=await canvas.convertToBlob({type:'image/png'});
      const raw=new Uint8Array(await blob.arrayBuffer());
      let binary='';
      for(let i=0;i<raw.length;i+=0x8000) binary+=String.fromCharCode(...raw.subarray(i,i+0x8000));
      images.push({size,alpha:{min:smin,max:smax},png:btoa(binary)});
    }
    image.close();
    return {width,height,alpha:{min,max,bounds:crop},images};
  })()`);
  window.destroy();
  if (decoded.alpha.min !== 0 || decoded.alpha.max !== 255) throw Error('Logo 原件透明通道与归档不一致');
  fs.mkdirSync(outDir, { recursive: true });
  const images = decoded.images.map(image => ({ size: image.size, alpha: image.alpha, png: Buffer.from(image.png, 'base64') }));
  for (const image of images) {
    if (image.alpha.max < 16) throw Error(`${image.size} 图标没有可见像素`);
    fs.writeFileSync(path.join(outDir, `icon-${image.size}.png`), image.png);
    const check = nativeImage.createFromBuffer(image.png);
    if (check.isEmpty() || check.getSize().width !== image.size) throw Error(`${image.size} 图标无法由宿主解码`);
  }
  fs.writeFileSync(path.join(outDir, 'icon.ico'), pngIco(images));
  fs.writeFileSync(path.join(outDir, 'derive-report.json'), JSON.stringify({ width: decoded.width, height: decoded.height, alpha: decoded.alpha, sizes: images.map(image => ({ size: image.size, alpha: image.alpha, bytes: image.png.length })) }, null, 2));
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
