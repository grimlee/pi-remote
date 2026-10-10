import { invalid } from './control.mjs';
export const MAX_IMAGE_BYTES=2*1024*1024;
export const MAX_IMAGES=3;
export const MAX_IMAGE_REQUEST=9*1024*1024;
export function validateImages(value) {
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>MAX_IMAGES)throw invalid('invalid_images');
 return value.map(image=>{
  if(!image||image.type!=='image'||!['image/png','image/jpeg','image/webp','image/gif'].includes(image.mimeType)||typeof image.data!=='string')throw invalid('invalid_image');
  if(image.data.length>Math.ceil(MAX_IMAGE_BYTES/3)*4)throw invalid('image_too_large',413);
  if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data))throw invalid('invalid_image_base64');
  const bytes=Buffer.from(image.data,'base64');if(!bytes.length||bytes.length>MAX_IMAGE_BYTES)throw invalid('image_too_large',413);
  const matches=image.mimeType==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):image.mimeType==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:image.mimeType==='image/gif'?['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)):bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
  if(!matches)throw invalid('image_mime_mismatch');
  return {type:'image',mimeType:image.mimeType,data:image.data};
 });
}
