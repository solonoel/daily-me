with open('index.html', 'r', encoding='utf-8') as f:
    c = f.read()

# Fix 1: Remove early applyNavMode() — data not ready yet
old1 = """    _navMode=launchMode==='Nav';
    applyNavMode();"""
new1 = """    _navMode=launchMode==='Nav';
    // applyNavMode() deferred until all data is loaded below"""
print('Fix 1 found:', c.count(old1))
c = c.replace(old1, new1, 1)

# Fix 2: After renderSysHeaderButtons() (all data now loaded),
# insert: popup redirect for Nav regular tab, then applyNavMode().
# This runs BEFORE loadHeadlines() so no double-load occurs.
old2 = """    renderLanguageNav();
    renderSysHeaderButtons();
    const loadMs=Math.round(performance.now()-loadStart);"""
new2 = """    renderLanguageNav();
    renderSysHeaderButtons();
    // All data loaded — now safe to apply mode or redirect
    {
      const _urlParams=new URLSearchParams(window.location.search);
      const _forceMode=_urlParams.get('forceMode');
      if(_navMode && !_forceMode){
        // Regular tab with Nav preference: reopen as correctly-sized popup
        const _perRow=parseInt(document.getElementById('us-navbuttonsperrow')?.value)||4;
        const _panelW=(_perRow*56+((_perRow-1)*4))+16;
        const _chrome=window.outerWidth-window.innerWidth||16;
        const _url=window.location.href.split('?')[0]+'?forceMode=Nav';
        window.open(_url,'dailyme_nav',`width=${_panelW+_chrome},height=${screen.availHeight},left=0,top=0,resizable=yes,scrollbars=no`);
        try{window.close();}catch(e){}
        return; // stop — popup handles all data loading
      }
      applyNavMode(); // Full mode, or ?forceMode=Nav popup
    }
    const loadMs=Math.round(performance.now()-loadStart);"""
print('Fix 2 found:', c.count(old2))
c = c.replace(old2, new2, 1)

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(c)
print('Done')