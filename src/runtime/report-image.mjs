import {readFile,stat,open} from 'node:fs/promises';
import path from 'node:path';

async function defaultBrowserFactory({executablePath,launchOptions={}}) {
 const {default:puppeteer}=await import('puppeteer-core');
 let args=[];
 if(!executablePath){
  if(process.platform!=='linux')throw new Error('REPORT_CHROMIUM_PATH required outside Linux');
  const {default:chromium}=await import('@sparticuz/chromium');
  executablePath=await chromium.executablePath();args=chromium.args;
 }
 return puppeteer.launch({...launchOptions,executablePath,headless:true,
  args:[...args,'--disable-background-networking','--disable-component-update','--disable-sync','--no-first-run','--no-default-browser-check'],
  // No persistent profile, user browser connection or authenticated session.
  userDataDir:undefined,timeout:15000});
}

/** Render only a host-generated report. Never connects to the user's browser.
 * Dependencies are lazily loaded; tests inject a fixture browserFactory.
 * All page requests except data URIs are rejected, including file and loopback.
 */
export async function renderReportImage(htmlPath,pngPath,{
 browserFactory=defaultBrowserFactory,executablePath=process.env.REPORT_CHROMIUM_PATH,
 timeoutMs=30000,maxHeight=24000,maxPixels=28800000,
}={}) {
 if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>120000)throw new Error('Invalid image timeout');
 if(!Number.isInteger(maxHeight)||maxHeight<1||!Number.isInteger(maxPixels)||maxPixels<1)throw new Error('Invalid image dimensions');
 if(path.resolve(htmlPath)===path.resolve(pngPath))throw new Error('Image must not overwrite HTML');
 const metadata=await stat(htmlPath);if(metadata.size>16000000)throw new Error('Report HTML exceeds size limit');
 const html=await readFile(htmlPath,'utf8');
 // First restrictive policy wins in addition to any existing report policy.
 const policy=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'">`;
 let browser,page,timer,expired=false;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(new Error('Report image timeout'));},timeoutMs);});
 const browserPromise=Promise.resolve().then(()=>browserFactory({executablePath}));
 // A slow launch resolving after the deadline must not orphan its process.
 browserPromise.then(b=>{if(expired&&!browser)Promise.resolve(b.close()).catch(()=>{});},()=>{});
 try {
  return await Promise.race([deadline,(async()=>{
   browser=await browserPromise;if(expired)throw new Error('Report image timeout');
   page=await browser.newPage();if(expired)throw new Error('Report image timeout');
   page.setDefaultTimeout(timeoutMs);page.setDefaultNavigationTimeout(timeoutMs);
   await page.setJavaScriptEnabled(false);
   await page.setViewport({width:1200,height:900,deviceScaleFactor:1});
   await page.setRequestInterception(true);
   page.on('request',request=>{
    const action=request.url().startsWith('data:')?request.continue():request.abort('blockedbyclient');
    Promise.resolve(action).catch(()=>{});
   });
   const documentHtml=/<head\b[^>]*>/i.test(html)?html.replace(/<head\b[^>]*>/i,match=>match+policy):policy+html;
   await page.setContent(documentHtml,{waitUntil:'load',timeout:timeoutMs});
   if(expired)throw new Error('Report image timeout');
   const dimensions=await page.evaluate(async()=>{
    if(document.fonts)await document.fonts.ready;
    return {width:Math.max(document.documentElement.scrollWidth,document.body?.scrollWidth||0),height:Math.max(document.documentElement.scrollHeight,document.body?.scrollHeight||0)};
   });
   if(expired)throw new Error('Report image timeout');
   if(!Number.isFinite(dimensions.width)||!Number.isFinite(dimensions.height)||dimensions.width<1||dimensions.height<1||dimensions.width>1200||dimensions.height>maxHeight||dimensions.width*dimensions.height>maxPixels)throw new Error('Report image dimension/pixel limit exceeded');
   // Exclusive target reservation: never replace an existing report artifact.
   const target=await open(pngPath,'wx');await target.close();
   await page.screenshot({path:pngPath,type:'png',fullPage:true,captureBeyondViewport:true});
   return {pngPath,width:dimensions.width,height:dimensions.height};
  })()]);
 } finally {
  clearTimeout(timer);
  // Cleanup is itself bounded even if the browser is unresponsive.
  await Promise.allSettled([page,browser].filter(Boolean).map(value=>new Promise(resolve=>{
   const cleanupTimer=setTimeout(resolve,3000);
   Promise.resolve().then(()=>value.close()).catch(()=>{}).finally(()=>{clearTimeout(cleanupTimer);resolve();});
  })));
 }
}
