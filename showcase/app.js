import { createPlayback } from './playback.js';
const flows=[
 ['浏览器观测','从首次导航之前开始','隔离 Chromium 会话、目标地址与可选 TLS / Redfish 事实。','挂载 CDP / NetLog、Target 与运行时观测器；记录 HTTP、脚本、通道、动作和浏览器状态。','带 Target、请求与通道标识的原始事件；不可观察或读取失败明确记账。'],
 ['原始事实落盘','先保存，再做判断','HTTP 正文、脚本、帧 payload 与追加事件。','JobWorkspace 管理单作业与磁盘水位；BodyStore 按 SHA-256 寻址、流式写入和去重。','raw/ 工件与内容引用；写入失败进入缺口，异常退出保留恢复工作区。'],
 ['证据关联','把事实连成可复核的链','Target 血缘、点击与导航时序、请求和实际值。','建立资源索引与关系；以实际观察背书登录、Viewer 与通道候选链，不按厂商分类。','catalog/ 索引、关系及值传播；不补造悬空引用或未观察行为。'],
 ['状态与完整度','进展和完整，是两个维度','只读事实快照、资源引用与采集缺口。','派生 TARGET_OPENED / LOGIN_REACHED / KVM_REACHED 和十项完整度门禁；Viewer 稳定后自动收尾。','COMPLETE / INCOMPLETE 与稳定原因代码。自动收尾不自动导出；预导出状态不等于 ZIP 已验证。'],
 ['导航与 Replay','沿包内事实重新研究','原始工件、资源索引、候选链与已观察值传播。','派生 AI 入口、Adapter dossier、缺失证据及动态值 / 通道 Replay 计划。','ai/ 与 replay/；都是证据导航和测试计划，不是协议分类或自动 Adapter。'],
 ['校验并导出','用户决定何时交接','收尾作业、完整度结果与保存位置。','流式生成 ZIP64，附上 33 份 Schema 与 checksum，重新打开检查引用、字节数、哈希和结构。','Capture Pack 2.0；成功才显示“已导出并校验”，失败保留资料供重试。']
];
const gateNames=['首次导航前就绪','Target 挂载','HTTP 正文','脚本 / Worker / WASM','实时通道','无未采集通道','原始日志关闭','浏览器状态','证据引用闭环','ZIP 自校验'];
const steps=[['浏览器事实','请求与目标'],['登录候选','请求与值传播'],['Viewer / 通道','脚本与握手'],['完整度','门禁与缺口'],['导出与交接','目录与阅读入口']];
const $=s=>document.querySelector(s);
function el(tag,text,className){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;}
function jsonView(data){const pre=el('pre',JSON.stringify(data,null,2));pre.tabIndex=0;return pre;}
let flowIndex=0,flowPlayer,casePlayer;
function flow(index){flowIndex=index;document.querySelectorAll('[data-flow]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.flow)===index)));const f=flows[index],box=$('#flow-detail');box.replaceChildren();const left=el('div');left.append(el('h3',f[1]),el('p',`0${index+1} / ${f[0]}`,'caption mono'));const dl=el('dl');['输入','处理','输出'].forEach((label,j)=>dl.append(el('dt',label),el('dd',f[j+2])));box.append(left,dl);}
flows.forEach((f,i)=>{const b=el('button');b.type='button';b.dataset.flow=i;b.append(el('span',`0${i+1}`),el('strong',f[0]));b.addEventListener('click',()=>{flowPlayer?.pause();flow(i);});$('#flow-nodes').append(b);});flow(0);
let data,caseName='complete',stepIndex=0;
function evidence(){if(!data)return;document.querySelectorAll('[data-step]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.step)===stepIndex)));const box=$('#evidence-detail');box.replaceChildren();const transactions=data.files['raw/http/transactions.jsonl'];const integrity=data[caseName];let title,description,record,kind;
 switch(stepIndex){case 0:title='首次访问留下原始请求';description='固定 seed Mock 的随机路径。不依赖厂商 URL 规则，正文按内容寻址保存。';record=transactions[0];kind='HTTP';break;
 case 1:title='沿登录候选核对实际请求';description='以下请求来自专用 Mock。候选 ID 与值传播只是观察依据，不代表自动登录或协议识别。';record=transactions.find(r=>r.id===data.files['ai/index.json'].loginCandidateRequestIds[0]);kind='HTTP';break;
 case 2:title=caseName==='complete'?'Viewer 与通道资料有据可查':'看到了 Viewer，不代表源码完整';description=caseName==='complete'?'样例保存脚本索引与 WebSocket 通道；此案例没有 WebRTC、WebTransport 或 WASM，目录格式不能冒充已实际覆盖。':'故障 Fixture 注入 blob Worker 源码缺失。工作流仍为 KVM_REACHED，完整度因缺口降级；没有伪造一条失败的浏览器请求。';record=caseName==='complete'?{scripts:data.files['raw/scripts/index.json'],channels:data.files['catalog/channels.json']}:{fixtureId:data.incomplete.fixtureId,scenario:data.incomplete.scenario,missingWorkerSources:[{id:'script-worker-0002',detail:'blob: Worker 入口源码缺失'}]};kind='TARGET';break;
 case 3:title=caseName==='complete'?'定义范围内的证据通过门禁':'Worker 源码缺口必须显式报告';description=caseName==='complete'?'十项门禁通过，且已观察到 KVM。不能据此宣称所有固件兼容或 Adapter 已实现。':'INCOMPLETE_WORKER_SOURCE 对应 scripts-workers-wasm-complete 失败。其余门禁通过也不能覆盖这个缺口。';record=integrity;kind='INTEGRITY';break;
 default:title=caseName==='complete'?'手动导出后，先读三个入口':'未完整包仍可交接分析';description=caseName==='complete'?'正式导出要验证 ZIP；本站查看的是已有样例文件，不在浏览器生成新的采集包。':'客户端允许用户手动“导出未完整包”，也可保留原始资料。此故障 Fixture 只验证完整度逻辑，不声称已经导出过对应 ZIP。';record={readingOrder:data.files['ai/index.json'].readingOrder,captureIntegrity:integrity.captureIntegrity,workflowStatus:'KVM_REACHED',containsSensitiveData:true,dataHandling:'UNREDACTED'};kind='PACK';}
 $('#evidence-kind').textContent=kind;box.append(el('h3',title),el('p',description),jsonView(record));}
function renderCase(){document.querySelectorAll('[data-case]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.case===caseName)));const complete=caseName==='complete',integrity=data[caseName];$('#case-title').textContent=complete?'未知路径，同样可以留下完整证据。':'工作流到达 KVM，证据仍可能有缺口。';$('#case-description').textContent=complete?'固定 seed 的随机 URL Mock 样例，COMPLETE + KVM_REACHED。':'故障注入：blob Worker 入口源码缺失，INCOMPLETE + KVM_REACHED。';$('#case-status').textContent=integrity.captureIntegrity;$('#case-status').className='status'+(complete?'':' incomplete');$('#case-source').textContent=complete?data.source:'来源：src/core/capture-pack-v2/integrityFixtures.ts → fixture-worker-source-missing；结果由项目 derivePackIntegrity 实际派生，构建时固化。';$('#gate-list').replaceChildren();integrity.gates.forEach((gate,i)=>{const row=el('div',undefined,'gate'+(gate.passed?'':' failed'));row.title=gate.id;row.append(el('span',String(i+1).padStart(2,'0'),'gate-no'),el('span',gateNames[i]),el('span',gate.passed?(complete?'通过':'预设通过'):'缺口','result'));$('#gate-list').append(row);});evidence();}
steps.forEach((s,i)=>{const b=el('button');b.type='button';b.dataset.step=i;const label=el('span');label.append(el('strong',s[0]),el('small',s[1]));b.append(el('span',i+1,'step-number'),label);b.addEventListener('click',()=>{casePlayer?.pause();stepIndex=i;evidence();});$('#case-steps').append(b);});
document.querySelectorAll('[data-case]').forEach(b=>b.addEventListener('click',()=>{if(!data)return;casePlayer?.pause();caseName=b.dataset.case;stepIndex=0;renderCase();}));
try{const response=await fetch(new URL('./data/cases.json',import.meta.url));if(!response.ok)throw Error('无法读取案例');data=await response.json();renderCase();Object.keys(data.files).forEach(path=>{const option=el('option',path);option.value=path;$('#file-select').append(option);});function showFile(){$('#file-content').textContent=JSON.stringify(data.files[$('#file-select').value],null,2);}$('#file-select').addEventListener('change',showFile);showFile();}catch(error){$('#case-title').textContent='案例暂时无法加载';$('#case-description').textContent='请刷新页面，或从 GitHub 查看公开合成样例。';$('#case-status').textContent='加载失败';document.querySelectorAll('[data-case],[data-step]').forEach(b=>b.disabled=true);$('#file-content').textContent='请从页面上的 GitHub 文档入口阅读样例。';}

function connectPlayback({ control, target, detail, interval, advance, ready = () => true }) {
 const bar=$(control),button=bar.querySelector('button');
 const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
 const player=createPlayback({interval,advance,enabled:!reducedMotion.matches,onChange(state){
  button.disabled=!ready();
  button.textContent=state.enabled?'暂停播放':'自动播放';
  button.setAttribute('aria-pressed',String(state.enabled));
  bar.dataset.running=String(state.running);
  bar.style.setProperty('--playback-duration',`${interval}ms`);
  $(detail).setAttribute('aria-live',state.enabled?'off':'polite');
 }});
 button.addEventListener('click',()=>player.toggle());
 new IntersectionObserver(entries=>player.setVisible(entries[0].isIntersecting && entries[0].intersectionRatio>=0.25),{threshold:[0,0.25]}).observe($(target));
 document.addEventListener('visibilitychange',()=>player.setForeground(!document.hidden));
 player.setForeground(!document.hidden);
 reducedMotion.addEventListener('change',event=>{if(event.matches)player.pause();});
 // Reading or scrolling evidence should never be interrupted by a timed replacement.
 $(detail).addEventListener('pointerdown',()=>player.pause());
 $(detail).addEventListener('focusin',()=>player.pause());
 $(detail).addEventListener('wheel',()=>player.pause(),{passive:true});
 $(detail).addEventListener('touchstart',()=>player.pause(),{passive:true});
 return player;
}
flowPlayer=connectPlayback({control:'#flow-playback',target:'#flow-nodes',detail:'#flow-detail',interval:2000,advance(){flow((flowIndex+1)%flows.length);}});
casePlayer=connectPlayback({control:'#case-playback',target:'.workbench',detail:'#evidence-detail',interval:2000,ready:()=>Boolean(data),advance(){if(data){stepIndex=(stepIndex+1)%steps.length;evidence();}}});
