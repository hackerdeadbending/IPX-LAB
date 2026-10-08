const MAIN_MENU={inline_keyboard:[[{text:"📐 Resize",callback_data:"resize"},{text:"📏 Exact Size",callback_data:"exact-size"}],[{text:"🗜️ Compress",callback_data:"compress"},{text:"🔄 Convert",callback_data:"convert"}],[{text:"✂️ Crop",callback_data:"crop"},{text:"🛡️ Safe Share",callback_data:"safe-share"}],[{text:"🧹 Remove Metadata",callback_data:"metadata"}],[{text:"ℹ️ Image Info",callback_data:"info"}]]};
const RESIZE_MENU={inline_keyboard:[[{text:"800 px",callback_data:"resize:800"},{text:"1200 px",callback_data:"resize:1200"},{text:"1600 px",callback_data:"resize:1600"}],[{text:"✏️ Custom width",callback_data:"resize:custom"}],[{text:"↩️ Back",callback_data:"back"}]]};
const EXACT_SIZE_MENU={inline_keyboard:[[{text:"512 × 512",callback_data:"exact:512:512"},{text:"512 × 1900",callback_data:"exact:512:1900"}],[{text:"1080 × 1080",callback_data:"exact:1080:1080"},{text:"1080 × 1920",callback_data:"exact:1080:1920"}],[{text:"A5 — 1748 × 2480",callback_data:"exact:1748:2480"},{text:"A4 — 2480 × 3508",callback_data:"exact:2480:3508"}],[{text:"✏️ Any size",callback_data:"exact:custom"}],[{text:"↩️ Back",callback_data:"back"}]]};
const COMPRESS_MENU={inline_keyboard:[[{text:"High quality",callback_data:"compress:85"},{text:"Balanced",callback_data:"compress:70"}],[{text:"Small size",callback_data:"compress:50"}],[{text:"↩️ Back",callback_data:"back"}]]};
const CONVERT_MENU={inline_keyboard:[[{text:"JPG",callback_data:"convert:jpeg"},{text:"PNG",callback_data:"convert:png"}],[{text:"WEBP",callback_data:"convert:webp"},{text:"AVIF",callback_data:"convert:avif"}],[{text:"GIF",callback_data:"convert:gif"}],[{text:"↩️ Back",callback_data:"back"}]]};
const CROP_MENU={inline_keyboard:[[{text:"1:1",callback_data:"crop:1:1"},{text:"16:9",callback_data:"crop:16:9"}],[{text:"9:16",callback_data:"crop:9:16"},{text:"4:5",callback_data:"crop:4:5"}],[{text:"↩️ Back",callback_data:"back"}]]};
const SAFE_SHARE_MENU={inline_keyboard:[[{text:"🧹 Remove hidden metadata",callback_data:"safe-share:metadata"}],[{text:"📐 Limit long edge to 2000 px",callback_data:"safe-share:size"}],[{text:"🛡️ Apply both",callback_data:"safe-share:both"}],[{text:"↩️ Back",callback_data:"back"}]]};

async function telegram(method,token,body){
  const isMultipart=typeof FormData!=="undefined"&&body instanceof FormData;
  const init={method:"POST"};
  if(isMultipart){init.body=body;}else{init.headers={"content-type":"application/json"};init.body=JSON.stringify(body);}
  const response=await fetch(`https://api.telegram.org/bot${token}/${method}`,init);
  const data=await response.json();
  if(!data.ok)throw new Error(data.description||`Telegram ${method} failed`);
  return data.result;
}
function textResponse(text,status=200){return new Response(text,{status,headers:{"content-type":"text/plain; charset=utf-8"}});}
function getSourceFileId(message){if(message?.photo?.length)return message.photo[message.photo.length-1].file_id;if(message?.document?.mime_type?.startsWith("image/"))return message.document.file_id;return null;}
async function ensureSourceTable(env){if(!env.DB)return;await env.DB.prepare(`CREATE TABLE IF NOT EXISTS source_images (telegram_id TEXT PRIMARY KEY,file_id TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run();}
async function rememberSource(env,chatId,fileId){if(!env.DB||!chatId||!fileId)return;await ensureSourceTable(env);await env.DB.prepare(`INSERT INTO source_images (telegram_id,file_id,updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(telegram_id) DO UPDATE SET file_id=excluded.file_id,updated_at=CURRENT_TIMESTAMP`).bind(String(chatId),fileId).run();}
async function getRememberedSource(env,chatId){if(!env.DB||!chatId)return null;await ensureSourceTable(env);const row=await env.DB.prepare("SELECT file_id FROM source_images WHERE telegram_id=?").bind(String(chatId)).first();return row?.file_id||null;}
async function resolveSourceFileId(env,chatId,message){return getSourceFileId(message)||await getRememberedSource(env,chatId);}
function stripJpegMetadataBytes(input){
  const bytes=new Uint8Array(input);if(bytes.length<4||bytes[0]!==0xff||bytes[1]!==0xd8)return input;
  const out=[0xff,0xd8];let i=2;
  while(i<bytes.length){
    if(bytes[i]!==0xff){out.push(bytes[i++]);continue;}
    if(i+1>=bytes.length){out.push(bytes[i++]);continue;}
    if(bytes[i+1]===0x00){out.push(0xff,0x00);i+=2;continue;}
    while(i<bytes.length&&bytes[i]===0xff)i++;
    if(i>=bytes.length)break;
    const marker=bytes[i++];
    if(marker===0xd9){out.push(0xff,marker);break;}
    if(marker===0x01||(marker>=0xd0&&marker<=0xd7)){out.push(0xff,marker);continue;}
    if(i+1>=bytes.length)break;
    const len=(bytes[i]<<8)|bytes[i+1];if(len<2||i+len>bytes.length)break;
    const isMetadata=marker===0xfe||(marker>=0xe0&&marker<=0xef);
    if(!isMetadata){out.push(0xff,marker);for(let j=0;j<len;j++)out.push(bytes[i+j]);}
    i+=len;
  }
  return new Uint8Array(out).buffer;
}
function formatBytes(bytes){if(!Number.isFinite(bytes))return "unknown";if(bytes<1024)return `${bytes} B`;if(bytes<1024*1024)return `${(bytes/1024).toFixed(1)} KB`;return `${(bytes/1024/1024).toFixed(2)} MB`;}
async function getTelegramFile(token,fileId){const file=await telegram("getFile",token,{file_id:fileId});if(!file?.file_path)throw new Error("Telegram did not return a file path");const response=await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);if(!response.ok||!response.body)throw new Error(`Unable to download Telegram file (${response.status})`);return response;}
async function sendPhotoMenu(token,chatId,fileId,isDocument=false){if(isDocument){await telegram("sendMessage",token,{chat_id:chatId,text:"📸 Photo file received\n\nChoose an operation:",reply_markup:MAIN_MENU});return;}await telegram("sendPhoto",token,{chat_id:chatId,photo:fileId,caption:"📸 Photo received\n\nChoose an operation:",reply_markup:MAIN_MENU});}
async function sendTransformedFile(token,chatId,response,filename,caption){const bytes=await response.arrayBuffer();if(!bytes.byteLength)throw new Error("Image transformation returned an empty file");const contentType=response.headers.get("content-type")||"application/octet-stream";const form=new FormData();form.append("chat_id",String(chatId));form.append("document",new File([bytes],filename,{type:contentType}));form.append("caption",caption||"");form.append("reply_markup",JSON.stringify(MAIN_MENU));const result=await telegram("sendDocument",token,form);const fileId=result?.document?.file_id||result?.photo?.at(-1)?.file_id;if(!fileId)throw new Error("Telegram returned the transformed image but no reusable file_id");return {message:result,fileId};}
function conversion(action){const formats={"convert:jpeg":["image/jpeg","jpg"],"convert:png":["image/png","png"],"convert:webp":["image/webp","webp"],"convert:avif":["image/avif","avif"],"convert:gif":["image/gif","gif"]};return formats[action]||null;}
async function transformImage(env,token,chatId,fileId,action){
  if(!fileId)throw new Error("Current photo is no longer available. Please send the photo again.");
  const source=await getTelegramFile(token,fileId);
  if(!env.IMAGES)throw new Error("Cloudflare Images binding is not configured");
  if(action==="info"){
    const info=await env.IMAGES.info(source.body);const width=info?.width??"unknown";const height=info?.height??"unknown";const size=info?.fileSize?formatBytes(info.fileSize):"unknown";const format=info?.format||"unknown";const mp=Number.isFinite(info?.width)&&Number.isFinite(info?.height)?((info.width*info.height)/1000000).toFixed(2):"unknown";
    await telegram("sendMessage",token,{chat_id:chatId,text:`ℹ️ Image Info\n\nResolution: ${width} × ${height}\nFormat: ${format}\nSize: ${size}\nMegapixels: ${mp} MP`,reply_markup:MAIN_MENU});return;
  }
  let transform={fit:"scale-down"};let outputFormat="image/jpeg";let quality=88;let filename="ipx-lab-result.jpg";let caption="✅ Done";
  if(action==="metadata"){transform={fit:"scale-down",metadata:"none"};quality=100;filename="ipx-lab-metadata-removed.jpg";caption="✅ Metadata removed";}
  else if(action==="safe-share:metadata"){transform={fit:"scale-down",metadata:"none"};quality=100;filename="ipx-lab-safe-share-metadata.jpg";caption="🛡️ Safe Share ready\n\n✓ Hidden metadata removed\n✓ GPS/EXIF removed";}
  else if(action==="safe-share:size"){transform={width:2000,fit:"scale-down"};quality=90;filename="ipx-lab-safe-share-2000px.jpg";caption="🛡️ Safe Share copy ready\n\n✓ Long edge limited to 2000 px";}
  else if(action==="safe-share:both"){transform={width:2000,fit:"scale-down",metadata:"none"};quality=90;filename="ipx-lab-safe-share.jpg";caption="🛡️ Safe Share ready\n\n✓ Hidden metadata removed\n✓ Long edge limited to 2000 px";}
  else if(action.startsWith("resize:")){
    const parts=action.split(":");const width=Number(parts[1]);const height=parts[2]?Number(parts[2]):null;
    if(!Number.isInteger(width)||width<50||width>10000)throw new Error("Invalid resize width");
    if(height!==null&&(!Number.isInteger(height)||height<50||height>10000))throw new Error("Invalid resize height");
    transform=height===null?{width,fit:"scale-down"}:{width,height,fit:"pad",background:"#ffffff"};filename=height?`ipx-lab-resize-${width}x${height}.jpg`:`ipx-lab-resize-${width}.jpg`;caption=`📐 Resize complete\n\n${width}${height?` × ${height}`:" px wide"}`;
  }
  else if(action.startsWith("exact:")){
    const parts=action.split(":");const width=Number(parts[1]);const height=Number(parts[2]);
    if(!Number.isInteger(width)||!Number.isInteger(height)||width<50||width>10000||height<50||height>10000)throw new Error("Invalid exact size");
    transform={width,height,fit:"pad",background:"#ffffff"};filename=`ipx-lab-exact-${width}x${height}.jpg`;caption=`📏 Exact size complete\n\n${width} × ${height} px`;
  }
  else if(action.startsWith("compress:")){quality=Number(action.split(":")[1]);if(![50,70,85].includes(quality))throw new Error("Invalid compression quality");filename=`ipx-lab-compressed-${quality}.jpg`;caption=`🗜️ Compression complete\n\nQuality: ${quality}%`;}
  else if(conversion(action)){const [format,ext]=conversion(action);outputFormat=format;quality=format==="image/png"||format==="image/gif"?undefined:88;filename=`ipx-lab-converted.${ext}`;caption=`🔄 Conversion complete\n\nFormat: ${ext.toUpperCase()}`;}
  else if(action.startsWith("crop:")){const [,ratioW,ratioH]=action.split(":");const w=Number(ratioW);const h=Number(ratioH);if(!Number.isFinite(w)||!Number.isFinite(h)||w<=0||h<=0)throw new Error("Invalid crop ratio");const base=1200;const width=w>=h?base:Math.round(base*w/h);const height=w>=h?Math.round(base*h/w):base;transform={width,height,fit:"cover"};filename=`ipx-lab-crop-${ratioW}x${ratioH}.jpg`;caption=`✂️ Crop complete\n\nRatio: ${ratioW}:${ratioH}`;}
  else throw new Error("Unknown image action");
  const pipeline=env.IMAGES.input(source.body).transform(transform);const output=await pipeline.output({format:outputFormat,...(quality!==undefined?{quality}:{})});let resultResponse=output.response();if(!resultResponse.ok)throw new Error(`Image transformation failed (${resultResponse.status})`);if(action==="metadata"||action==="safe-share:metadata"||action==="safe-share:both"){const cleaned=stripJpegMetadataBytes(await resultResponse.arrayBuffer());resultResponse=new Response(cleaned,{status:200,headers:{"content-type":"image/jpeg"}});}
  const sent=await sendTransformedFile(token,chatId,resultResponse,filename,caption);await rememberSource(env,chatId,sent.fileId);
}
function parseCustomResize(text){const raw=String(text||"").trim().toLowerCase().replace(/,/g,".").replace(/[xх×]/g,"x");const match=raw.match(/^(\d{2,5})(?:\s*x\s*(\d{2,5}))?$/);if(!match)return null;const width=Number(match[1]);const height=match[2]?Number(match[2]):null;if(width<50||width>10000||(height!==null&&(height<50||height>10000)))return null;return{width,height};}
async function handleCustomResize(env,token,chatId,text,replyToMessage=null){const size=parseCustomResize(text);if(!size)return false;const fileId=await resolveSourceFileId(env,chatId,replyToMessage);if(!fileId)throw new Error("Current photo is no longer available. Please send the photo again.");const action=size.height===null?`resize:${size.width}`:`resize:${size.width}:${size.height}`;await telegram("sendMessage",token,{chat_id:chatId,text:`⏳ Resizing to ${size.width}${size.height?` × ${size.height}`:" px wide"}...`});await transformImage(env,token,chatId,fileId,action);return true;}
async function showMenu(token,chatId,message,replyMarkup,fallbackText){if(message?.message_id){try{await telegram("editMessageReplyMarkup",token,{chat_id:chatId,message_id:message.message_id,reply_markup:replyMarkup});return;}catch(error){console.error("IPX LAB menu edit error",error);}}await telegram("sendMessage",token,{chat_id:chatId,text:fallbackText,reply_markup:replyMarkup});}
export default{async fetch(request,env){
  if(request.method!=="POST")return textResponse("IPX LAB Photo is online.");const token=env.TELEGRAM_BOT_TOKEN;if(!token)return textResponse("Missing TELEGRAM_BOT_TOKEN",500);let update;try{update=await request.json();}catch{return textResponse("Invalid JSON",400);}
  try{
    if(update.message){const chatId=update.message.chat?.id;if(!chatId)return textResponse("OK");const fileId=getSourceFileId(update.message);if(fileId){await rememberSource(env,chatId,fileId);await sendPhotoMenu(token,chatId,fileId,Boolean(update.message.document?.mime_type?.startsWith("image/")));return textResponse("OK");}if(update.message.text){const handled=await handleCustomResize(env,token,chatId,update.message.text,update.message.reply_to_message);if(handled)return textResponse("OK");}}
    if(update.callback_query){const query=update.callback_query;const chatId=query.message?.chat?.id;const action=query.data||"";await telegram("answerCallbackQuery",token,{callback_query_id:query.id});if(!chatId)return textResponse("OK");const callbackFileId=getSourceFileId(query.message);const fileId=callbackFileId||await getRememberedSource(env,chatId);
      if(action==="back")await showMenu(token,chatId,query.message,MAIN_MENU,"Choose an operation:");
      else if(action==="resize")await showMenu(token,chatId,query.message,RESIZE_MENU,"📐 Choose the maximum width or custom size:");
      else if(action==="exact-size")await showMenu(token,chatId,query.message,EXACT_SIZE_MENU,"📏 Choose exact output dimensions:");
      else if(action==="resize:custom"){if(!fileId)throw new Error("Please send a photo first");await telegram("sendMessage",token,{chat_id:chatId,text:"✏️ Enter the maximum width.\n\nExample: 1500\nThe height keeps the original proportion.\n\nMinimum: 50 px · Maximum: 10000 px",reply_parameters:{message_id:query.message.message_id},reply_markup:{force_reply:true,input_field_placeholder:"1500"}});}
      else if(action==="exact:custom"){if(!fileId)throw new Error("Please send a photo first");await telegram("sendMessage",token,{chat_id:chatId,text:"✏️ Enter exact dimensions.\n\nExamples: 512x512, 512x1900, 1080x1920\nYou can use x, × or х between numbers.\n\nMinimum: 50 px · Maximum: 10000 px",reply_parameters:{message_id:query.message.message_id},reply_markup:{force_reply:true,input_field_placeholder:"512x1900"}});}
      else if(action==="compress")await showMenu(token,chatId,query.message,COMPRESS_MENU,"🗜️ Choose compression quality:");
      else if(action==="convert")await showMenu(token,chatId,query.message,CONVERT_MENU,"🔄 Choose the output format:");
      else if(action==="crop")await showMenu(token,chatId,query.message,CROP_MENU,"✂️ Choose the crop ratio:");
      else if(action==="safe-share")await showMenu(token,chatId,query.message,SAFE_SHARE_MENU,"🛡️ Choose a Safe Share option:");
      else if(action==="info"||action==="metadata"||["safe-share:metadata","safe-share:size","safe-share:both"].includes(action)){if(!fileId)throw new Error("Please send a photo first");await transformImage(env,token,chatId,fileId,action);}
      else if(action.startsWith("resize:")||action.startsWith("exact:")||action.startsWith("compress:")||action.startsWith("convert:")||action.startsWith("crop:")){if(!fileId)throw new Error("Please send a photo first");await transformImage(env,token,chatId,fileId,action);}
    }
    return textResponse("OK");
  }catch(error){console.error("IPX LAB error",error);const chatId=update?.message?.chat?.id||update?.callback_query?.message?.chat?.id;if(chatId){try{await telegram("sendMessage",token,{chat_id:chatId,text:`❌ ${error?.message||"Something went wrong"}`});}catch(sendError){console.error("IPX LAB error notification failed",sendError);}}return textResponse("OK");}
}};