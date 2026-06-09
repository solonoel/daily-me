with open('index.html', 'r', encoding='utf-8') as f:
    c = f.read()

old = """  function toggleLaunchMode(){
    _navMode=!_navMode;
    const newMode=_navMode?'Nav':'Full';
    document.querySelectorAll('input[name="us-launchmode"]').forEach(r=>r.checked=r.value===newMode);
    applyNavMode();
    apiPost('SaveUserSettings',{userID:USER_ID,launchMode:newMode});
  }"""

new = """  function toggleLaunchMode(){
    if(!_navMode){
      const perRow=parseInt(document.getElementById('us-navbuttonsperrow')?.value)||4;
      const panelWidth=(perRow*56+((perRow-1)*4))+16;
      const wChrome=window.outerWidth-window.innerWidth;
      const url=window.location.href.split('?')[0]+'?forceMode=Nav';
      window.open(url,'dailyme_nav',`width=${panelWidth+wChrome},height=${screen.availHeight},left=${screen.availWidth-panelWidth-wChrome},top=0,resizable=yes,scrollbars=no`);
      apiPost('SaveUserSettings',{userID:USER_ID,launchMode:'Nav'});
    } else {
      _navMode=false;
      document.querySelectorAll('input[name="us-launchmode"]').forEach(r=>r.checked=r.value==='Full');
      applyNavMode();
      apiPost('SaveUserSettings',{userID:USER_ID,launchMode:'Full'});
      try{window.resizeTo(1200,window.outerHeight);}catch(e){}
    }
  }"""

old2 = """    if(forceMode === 'Full' && _navMode){
      _navMode = false;
      applyNavMode();
    }
    if(autoLangID && autoLangName){"""

new2 = """    if(forceMode === 'Full' && _navMode){
      _navMode = false;
      applyNavMode();
    }
    if(forceMode === 'Nav'){
      _navMode = true;
      applyNavMode();
    }
    if(autoLangID && autoLangName){"""

print('toggleLaunchMode count:', c.count(old))
print('forceMode block count:', c.count(old2))
c = c.replace(old, new, 1)
c = c.replace(old2, new2, 1)
with open('index.html', 'w', encoding='utf-8') as f:
    f.write(c)
print('done')