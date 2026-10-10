export const MAX_IMAGES=3;
export const MAX_IMAGE_BYTES=2*1024*1024;
export const IMAGE_TYPES=['image/png','image/jpeg','image/webp','image/gif'];
export function checkFiles(files,currentCount=0) {
 if(files.length+currentCount>MAX_IMAGES)throw new Error('最多附加 3 张图片');
 for(const file of files) {
  if(!IMAGE_TYPES.includes(file.type))throw new Error('请选择 PNG、JPEG、WebP 或 GIF 图片');
  if(file.size<1||file.size>MAX_IMAGE_BYTES)throw new Error('每张图片必须小于 2 MiB');
 }
}
export async function readImages(files,currentCount=0) {
 checkFiles(files,currentCount);
 return Promise.all(files.map(file=>new Promise((resolve,reject)=>{
  const reader=new FileReader();reader.onerror=()=>reject(new Error('无法读取图片'));
  reader.onload=()=>{const data=String(reader.result).split(',')[1];if(!data)reject(new Error('图片为空'));else resolve({type:'image',mimeType:file.type,data});};reader.readAsDataURL(file);
 })));
}
