/**
 * MCP Apps view for find_destination (extension io.modelcontextprotocol/ui,
 * spec 2026-01-26). Hosts that render MCP Apps (Claude web/desktop/mobile,
 * ChatGPT, VS Code Copilot, M365 Copilot, Goose) show this page in a
 * sandboxed iframe next to the tool result; hosts that do not (Claude Code)
 * ignore it and the text answer stands on its own.
 *
 * The page is self-contained (no SDK, no external script): it speaks the
 * postMessage JSON-RPC protocol by hand. It renders either the quiz form
 * (when the tool answered with needsInput) or three destination cards, and
 * re-runs find_destination through the host's tools/call when the traveler
 * changes an answer.
 *
 * Compliance rules this view keeps:
 * - Links open through ui/open-link (or ChatGPT's openExternal), never by
 *   navigating the iframe.
 * - No Amazon link is ever shown here: the iframe is the host's domain, not
 *   voyagehacks.com, and Amazon's policies only allow tagged links on our own
 *   Site. Packing picks link to the VoyageHacks guide (productUrl).
 * - Every affiliate link sits under the disclosure line.
 * - Images load only from voyagehacks.com (declared in the CSP below).
 *
 * Underscore file name: Cloudflare Pages does not route it.
 */

export const TRIP_APP_URI = 'ui://voyagehacks/trip-finder.html';

export const TRIP_APP_META = {
  ui: {
    prefersBorder: true,
    csp: { resourceDomains: ['https://voyagehacks.com'], connectDomains: [] },
  },
  // ChatGPT's legacy field, kept so older ChatGPT builds allow the images.
  'openai/widgetCSP': { resource_domains: ['https://voyagehacks.com'], connect_domains: [] },
  'openai/widgetDescription': 'Destination ideas from the VoyageHacks trip finder, with booking links and packing picks.',
};

export const TRIP_APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VoyageHacks trip finder</title>
<style>
:root{--bg:#ffffff;--card:#f6f8fb;--fg:#15202b;--muted:#5b6878;--line:#dde3ea;--accent:#0b5cad;--accent-fg:#ffffff;--chip:#e8f0fa;--warm:#b45309;--warm-bg:#fdf3e6;color-scheme:light}
:root[data-theme="dark"]{--bg:#141a21;--card:#1c242e;--fg:#e8edf3;--muted:#9eabba;--line:#2c3744;--accent:#6fb0f0;--accent-fg:#0d1620;--chip:#203246;--warm:#f2b46a;--warm-bg:#33260f;color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{padding:14px;display:flex;flex-direction:column;gap:12px}
.head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap}
.head h1{font-size:15px;margin:0}
.head .sub{color:var(--muted);font-size:12.5px}
button,.btn{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:7px 11px}
button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent);font-weight:600}
.link{background:none;border:0;padding:0;color:var(--accent);text-decoration:underline;cursor:pointer}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;display:flex;flex-direction:column;min-width:0}
.ph{aspect-ratio:3/2;background:var(--chip) center/cover no-repeat;max-width:100%}
.body{padding:10px 11px 12px;display:flex;flex-direction:column;gap:7px;flex:1}
.name{font-weight:650;font-size:15px}
.country{color:var(--muted);font-weight:400}
.chips{display:flex;flex-wrap:wrap;gap:5px}
.chip{background:var(--chip);border-radius:99px;padding:2px 8px;font-size:12px}
.temp{background:var(--warm-bg);color:var(--warm);font-weight:600}
.actions{display:flex;flex-direction:column;gap:6px;margin-top:auto}
.actions button{width:100%;text-align:left}
.more{font-size:12.5px;color:var(--muted)}
.more summary{cursor:pointer}
.more button{margin-top:5px}
.form{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}
label{display:flex;flex-direction:column;gap:4px;font-size:12.5px;color:var(--muted)}
select,input{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:7px 8px}
.formrow{grid-column:1/-1;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pack{display:flex;flex-direction:column;gap:6px}
.pack h2{font-size:13px;margin:0;color:var(--muted);font-weight:600}
.packrow{display:flex;gap:8px;flex-wrap:wrap}
.packrow button{flex:1 1 180px;text-align:left;font-size:12.5px}
.packrow small{display:block;color:var(--muted)}
.note{font-size:11.5px;color:var(--muted)}
.empty{padding:12px;background:var(--card);border-radius:10px}
.busy{opacity:.55;pointer-events:none}
@media (prefers-reduced-motion:no-preference){.card{transition:transform .15s}.card:hover{transform:translateY(-1px)}}
</style>
</head>
<body>
<div class="wrap" id="app"><div class="note">Loading destination ideas…</div></div>
<script>
(function(){
  var MONTHS=['january','february','march','april','may','june','july','august','september','october','november','december'];
  var TYPES=[['beach','Beach'],['city','City break'],['hiking','Hiking'],['ski','Ski'],['campervan','Road trip'],['adventure','Adventure'],['digital-nomad','Working remotely']];
  var BUDGETS=[['budget','Budget'],['mid','Mid-range'],['luxury','Luxury']];
  var PARTIES=[['couple','Couple'],['solo','Solo'],['family','Family'],['friends','Friends']];
  var app=document.getElementById('app');
  var seq=0, pending={}, input={}, last=null, canOpen=true;

  function post(m){ try{ window.parent.postMessage(m,'*'); }catch(e){} }
  function rpc(method,params){ return new Promise(function(res,rej){ var id=++seq; pending[id]={res:res,rej:rej}; post({jsonrpc:'2.0',id:id,method:method,params:params||{}}); setTimeout(function(){ if(pending[id]){ delete pending[id]; rej(new Error('timeout')); } },20000); }); }
  function note(method,params){ post({jsonrpc:'2.0',method:method,params:params||{}}); }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
  function cap(s){ return s? s.charAt(0).toUpperCase()+s.slice(1):''; }
  function safeUrl(u){ return /^https:\\/\\//.test(u||'')? u : ''; }

  function openLink(url){
    url=safeUrl(url); if(!url) return;
    if(window.openai && typeof window.openai.openExternal==='function'){ try{ window.openai.openExternal({href:url}); return; }catch(e){} }
    rpc('ui/open-link',{url:url}).catch(function(){ try{ window.open(url,'_blank','noopener'); }catch(e){} });
  }

  function size(){ note('ui/notifications/size-changed',{width:document.documentElement.scrollWidth,height:Math.ceil(app.getBoundingClientRect().height)}); }
  if(window.ResizeObserver){ new ResizeObserver(size).observe(app); }

  function options(list,val){ return list.map(function(o){ var v=Array.isArray(o)?o[0]:o, l=Array.isArray(o)?o[1]:cap(o); return '<option value="'+esc(v)+'"'+(v===val?' selected':'')+'>'+esc(l)+'</option>'; }).join(''); }

  function formHtml(a,title){
    a=a||{};
    return '<div class="form" id="q" role="form">'+
      '<div class="formrow"><b>'+esc(title||'Where should you go? Answer four questions.')+'</b></div>'+
      '<label for="f-month">When<select id="f-month" required><option value="">Pick a month</option>'+options(MONTHS.concat(['flexible']),a.month)+'</select></label>'+
      '<label for="f-type">Kind of trip<select id="f-type" required><option value="">Pick one</option>'+options(TYPES,a.trip_type)+'</select></label>'+
      '<label for="f-budget">Budget<select id="f-budget">'+options(BUDGETS,a.budget||'mid')+'</select></label>'+
      '<label for="f-who">Who is going<select id="f-who">'+options(PARTIES,a.travelers||'couple')+'</select></label>'+
      '<label for="f-from">Flying from (airport code)<input id="f-from" maxlength="3" placeholder="e.g. LON" value="'+esc(a.origin||'')+'"></label>'+
      '<div class="formrow"><button class="primary" type="button" id="go">Show three destinations</button><span class="note" id="hint">Picks come from the VoyageHacks month guides.</span></div>'+
    '</div>';
  }

  function bindForm(){
    // A button, not a form submit: hosts sandbox this frame, often without
    // allow-forms, and a blocked submission never fires its submit event.
    var go=document.getElementById('go'); if(!go) return;
    go.addEventListener('click',function(e){
      e.preventDefault();
      var args={ month:val('f-month'), trip_type:val('f-type'), budget:val('f-budget'), travelers:val('f-who') };
      var from=val('f-from').toUpperCase().replace(/[^A-Z]/g,''); if(from) args.origin=from;
      if(input.lang) args.lang=input.lang; if(input.country) args.country=input.country;
      if(!args.month||!args.trip_type){ var h=document.getElementById('hint'); if(h) h.textContent='Pick a month and a kind of trip first.'; return; }
      run(args);
    });
  }
  function val(id){ var el=document.getElementById(id); return el? el.value : ''; }

  function run(args){
    input=args; app.classList.add('busy');
    var call = (window.openai && typeof window.openai.callTool==='function')
      ? window.openai.callTool('find_destination',args)
      : rpc('tools/call',{name:'find_destination',arguments:args});
    Promise.resolve(call).then(function(r){ app.classList.remove('busy'); render(r && (r.structuredContent||r)); })
      .catch(function(){ app.classList.remove('busy'); app.insertAdjacentHTML('afterbegin','<div class="empty">Could not load new picks. Ask in the chat instead.</div>'); size(); });
  }

  function card(p){
    var main=[], more=[];
    (p.links||[]).forEach(function(l){ (/^Hotels in |^Flights |^Flight search/.test(l.label) && main.length<2 ? main : more).push(l); });
    var chips=[];
    if(p.avgHighC!=null) chips.push('<span class="chip temp">'+esc(Math.round(p.avgHighC))+' °C</span>');
    (p.reasons||[]).slice(0,3).forEach(function(r){ chips.push('<span class="chip">'+esc(r)+'</span>'); });
    var img=safeUrl(p.image);
    return '<article class="card">'+
      (img?'<div class="ph" role="img" aria-label="'+esc(p.name)+'" style="background-image:url(\\''+esc(img)+'\\')"></div>':'')+
      '<div class="body"><div class="name">'+esc(p.name)+(p.country?' <span class="country">'+esc(p.country)+'</span>':'')+'</div>'+
      '<div class="chips">'+chips.join('')+'</div>'+
      (when(p.links)?'<div class="more">'+esc(when(p.links))+'</div>':'')+
      '<div class="actions">'+main.map(btn).join('')+
        '<button data-url="'+esc(p.guide)+'">Read the VoyageHacks guide</button>'+
        (more.length?'<details class="more"><summary>More options ('+more.length+')</summary>'+more.map(btn).join('')+'</details>':'')+
      '</div></div></article>';
  }
  function shortLabel(l){
    var m;
    if(/^Hotels in /.test(l.label)) return 'Hotels on Booking.com';
    if((m=/^Flights ([A-Z]{3}) to ([A-Z]{3})/.exec(l.label))) return 'Flights '+m[1]+' \u2192 '+m[2];
    if(/^Flight search/.test(l.label)) return 'Search flights';
    return l.label;
  }
  function btn(l,i){ return '<button'+(i===0?' class="primary"':'')+' data-url="'+esc(l.url)+'">'+esc(shortLabel(l))+'</button>'; }
  var MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function when(links){
    for(var i=0;i<(links||[]).length;i++){
      var m=/(\\d{4})-(\\d{2})-(\\d{2}) to (\\d{4})-(\\d{2})-(\\d{2}), ([^(]+) \\(/.exec(links[i].label);
      if(m) return +m[3]+' '+MON[+m[2]-1]+' to '+(+m[6])+' '+MON[+m[5]-1]+' '+m[4]+' · '+m[7];
    }
    return '';
  }

  function render(sc){
    if(!sc){ return; }
    last=sc;
    if(sc.answers){ input=Object.assign({},input,{month:sc.answers.month,trip_type:sc.answers.trip_type,budget:sc.answers.budget,travelers:sc.answers.travelers,origin:sc.answers.origin}); }
    var a=sc.answers||input;
    if(sc.needsInput && sc.needsInput.length && !(sc.picks||[]).length){
      app.innerHTML=formHtml(a); bindForm(); size(); return;
    }
    var picks=sc.picks||[];
    var head='<div class="head"><div><h1>'+(picks.length?'Three places for a '+esc(labelFor(TYPES,a.trip_type))+' trip in '+esc(a.month==='flexible'?'the next two months':cap(a.month)):'No match for these answers')+'</h1>'+
      '<div class="sub">'+esc(({budget:'Low budget',mid:'Mid-range budget',luxury:'Luxury budget'})[a.budget]||'Mid-range budget')+' · '+esc(labelFor(PARTIES,a.travelers))+(a.origin?' · from '+esc(a.origin):'')+'</div></div>'+
      '<button class="link" id="change">Change answers</button></div>';
    var cards=picks.length?'<div class="cards">'+picks.map(card).join('')+'</div>':'<div class="empty">Try another month or trip type.</div>';
    var pack=(sc.packing||[]).length?'<div class="pack"><h2>Pack for it (picks from the VoyageHacks buying guides)</h2><div class="packrow">'+
      sc.packing.map(function(g){ return '<button data-url="'+esc(g.productUrl)+'">'+esc(g.name)+'<small>'+esc(g.badge||g.category||'')+'</small></button>'; }).join('')+'</div></div>':'';
    var hasLinks=picks.some(function(p){ return (p.links||[]).length; });
    var foot='<div class="note">'+esc(sc.disclosure||'')+(hasLinks?' Prices and availability are shown on the booking site.':'')+(sc.tripFinder?' <button class="link" data-url="'+esc(sc.tripFinder)+'">Open the trip finder</button>':'')+'</div>';
    app.innerHTML=head+'<div id="formslot"></div>'+cards+pack+foot;
    document.getElementById('change').addEventListener('click',function(){ var s=document.getElementById('formslot'); s.innerHTML=s.innerHTML?'':formHtml(a,'Change your answers'); bindForm(); size(); });
    size();
  }
  function labelFor(list,v){ for(var i=0;i<list.length;i++) if(list[i][0]===v) return list[i][1]; return cap(v||''); }

  app.addEventListener('click',function(e){ var b=e.target.closest('[data-url]'); if(b){ e.preventDefault(); openLink(b.getAttribute('data-url')); } });

  window.addEventListener('message',function(e){
    var m=e.data; if(!m||m.jsonrpc!=='2.0') return;
    if(m.id!=null && pending[m.id] && !m.method){ var p=pending[m.id]; delete pending[m.id]; m.error? p.rej(m.error) : p.res(m.result); return; }
    if(m.method==='ui/notifications/tool-input'){ input=Object.assign({},(m.params&&m.params.arguments)||{}); return; }
    if(m.method==='ui/notifications/tool-result'){ render(m.params && m.params.structuredContent); return; }
    if(m.method==='ui/notifications/host-context-changed'){ theme(m.params); return; }
    if(m.method==='ui/resource-teardown' && m.id!=null){ post({jsonrpc:'2.0',id:m.id,result:{}}); return; }
    if(m.method==='ping' && m.id!=null){ post({jsonrpc:'2.0',id:m.id,result:{}}); }
  });
  function theme(ctx){ var t=ctx && (ctx.theme || (ctx.hostContext && ctx.hostContext.theme)); if(t==='dark'||t==='light') document.documentElement.setAttribute('data-theme',t); }

  // ChatGPT exposes the result directly as well.
  function fromOpenAI(){ if(window.openai){ theme({theme:window.openai.theme}); if(window.openai.toolOutput && !last) render(window.openai.toolOutput); } }
  window.addEventListener('openai:set_globals',fromOpenAI);

  if(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.setAttribute('data-theme','dark');
  rpc('ui/initialize',{protocolVersion:'2026-01-26',clientInfo:{name:'voyagehacks-trip-finder',version:'1.0.0'},appCapabilities:{availableDisplayModes:['inline']}})
    .then(function(r){ if(r){ theme(r.hostContext); if(r.hostCapabilities && r.hostCapabilities.openLinks===undefined){ canOpen=true; } } note('ui/notifications/initialized'); })
    .catch(function(){});
  fromOpenAI();
  setTimeout(function(){ if(!last){ app.innerHTML=formHtml(input); bindForm(); size(); } },2500);
})();
</script>
</body>
</html>`;
