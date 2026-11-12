/* ひきだし: opt-in GitHub synchronization. Credentials are held in memory only. */
(function () {
  'use strict';
  var OWNER = 'shingenmochi0208-oss';
  var REPO = 'netacho-data';
  var FILE = 'data.json';
  var ENDPOINT = 'https://api.github.com/repos/' + OWNER + '/' + REPO;
  var token = '';
  var timer = null;
  var busy = false;
  var rerun = false;
  var connected = false;
  var bridge = window.hikidashiBridge;

  function $(id) { return document.getElementById(id); }
  function status(message, kind) {
    var el = $('cloudSyncStatus');
    if (!el) return;
    el.textContent = message;
    el.dataset.kind = kind || 'info';
  }
  function apiHeaders() {
    return {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }
  async function api(path, options) {
    if (!token) throw new Error('GitHubに接続されていません');
    var response = await fetch(ENDPOINT + path, Object.assign({
      headers: apiHeaders(),
      cache: 'no-store'
    }, options || {}));
    if (response.status === 404 && path.indexOf('/contents/') === 0 && (!options || !options.method)) return null;
    if (!response.ok) {
      var problem = '';
      try { problem = (await response.json()).message || ''; } catch (_) {}
      if (response.status === 401) throw new Error('認証に失敗しました。トークンを確認してください');
      if (response.status === 403) throw new Error('権限がないか、APIの利用制限に達しました');
      if (response.status === 404) throw new Error('非公開リポジトリがないか、アクセス権限がありません');
      if (response.status === 409 || response.status === 422) {
        var conflict = new Error('別の端末によって更新されました');
        conflict.code = 'conflict'; throw conflict;
      }
      throw new Error('GitHub API エラー ' + response.status + (problem ? '：' + problem : ''));
    }
    return response.json();
  }
  function encodeBase64(text) {
    var bytes = new TextEncoder().encode(text);
    var str = '';
    for (var i = 0; i < bytes.length; i += 8192) {
      str += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return btoa(str);
  }
  function decodeBase64(value) {
    var str = atob(value.replace(/\s/g, ''));
    var bytes = Uint8Array.from(str, function (ch) { return ch.charCodeAt(0); });
    return new TextDecoder().decode(bytes);
  }
  function timestamp(value) {
    var t = Date.parse(value || '');
    return Number.isFinite(t) ? t : 0;
  }
  function normalize(state) {
    if (!state || !Array.isArray(state.items) || !state.deleted || typeof state.deleted !== 'object' || Array.isArray(state.deleted)) {
      throw new Error('クラウドのデータ形式が正しくありません。上書きせずに停止しました');
    }
    if (state.version && state.version > 1) throw new Error('新しいバージョンのデータです。アプリを更新してください');
    if (state.items.length > 10000) throw new Error('データ件数の上限を超えています');
    for (var i of state.items) {
      if (!i || typeof i.id !== 'string' || !i.id || typeof i.body !== 'string' || !i.body) {
        throw new Error('不正なネタデータを検出しました。上書きせずに停止しました');
      }
    }
    return {version: 1, items: state.items, deleted: state.deleted};
  }
  function merge(a, b) {
    a = normalize(a); b = normalize(b);
    var rows = new Map();
    var deleted = {};
    Object.assign(deleted, a.deleted, b.deleted);
    for (var key of Object.keys(a.deleted)) {
      if (timestamp(a.deleted[key]) > timestamp(deleted[key])) deleted[key] = a.deleted[key];
    }
    for (var key2 of Object.keys(b.deleted)) {
      if (timestamp(b.deleted[key2]) > timestamp(deleted[key2])) deleted[key2] = b.deleted[key2];
    }
    for (var item of a.items.concat(b.items)) {
      var previous = rows.get(item.id);
      if (!previous || timestamp(item.updatedAt) >= timestamp(previous.updatedAt)) rows.set(item.id, item);
    }
    var kept = [];
    for (var entry of rows) {
      var id = entry[0], value = entry[1];
      if (timestamp(deleted[id]) >= timestamp(value.updatedAt) && deleted[id]) {
        continue;
      }
      kept.push(value);
      if (deleted[id] && timestamp(value.updatedAt) > timestamp(deleted[id])) delete deleted[id];
    }
    return {version:1,items:kept.sort(function(x,y){return timestamp(x.createdAt)-timestamp(y.createdAt);}).reverse(),deleted:deleted};
  }
  function serial(state) {
    var clean = normalize(state);
    var sorted = clean.items.slice().sort(function(a,b){return a.id.localeCompare(b.id);});
    var ordered = Object.keys(clean.deleted).sort().map(function(k){return [k,clean.deleted[k]];});
    return JSON.stringify({items:sorted,deleted:ordered});
  }
  async function readRemote() {
    var item = await api('/contents/' + FILE + '?ts=' + Date.now());
    if (!item) return {sha:null,state:{version:1,items:[],deleted:{}}};
    if (!item.content || !item.sha) throw new Error('クラウドのデータが大きすぎるため読み込めません');
    var json = JSON.parse(decodeBase64(item.content));
    return {sha:item.sha,state:normalize(json)};
  }
  async function saveRemote(state, sha) {
    var raw = JSON.stringify({
      version:1, updatedAt:new Date().toISOString(), items:state.items, deleted:state.deleted
    },null,2);
    if (new TextEncoder().encode(raw).length > 800000) throw new Error('GitHub同期のデータ容量上限に近づいています。JSONを書き出してください');
    var body = {
      message: 'Sync Hikidashi notes',
      content: encodeBase64(raw)
    };
    if (sha) body.sha = sha;
    await api('/contents/' + FILE, {
      method:'PUT',
      headers:Object.assign({'Content-Type':'application/json'},apiHeaders()),
      body:JSON.stringify(body)
    });
  }
  async function once() {
    for (var attempt=0; attempt<3; attempt++) {
      var remote = await readRemote();
      var local = normalize(bridge.getState());
      var combined = merge(remote.state, local);
      if (serial(combined) === serial(remote.state)) {
        var latestLocal = normalize(bridge.getState());
        var safeMerged = merge(combined, latestLocal);
        bridge.applyCloudState(safeMerged);
        if(serial(safeMerged)!==serial(combined))rerun=true;
        status(rerun?'新しい変更を追加同期中…':'同期済み · ' + safeMerged.items.length + '件', rerun?'info':'ok');
        return;
      }
      try {
        await saveRemote(combined, remote.sha);
        var latestAfterUpload = merge(combined, normalize(bridge.getState()));
        bridge.applyCloudState(latestAfterUpload);
        if(serial(latestAfterUpload)!==serial(combined))rerun=true;
        status(rerun?'新しい変更を追加同期中…':'同期済み · ' + latestAfterUpload.items.length + '件', rerun?'info':'ok');
        return;
      } catch (error) {
        if (error.code !== 'conflict' || attempt === 2) throw error;
      }
    }
  }
  async function sync() {
    clearTimeout(timer); timer=null;
    if (!connected || !token || !navigator.onLine) {
      if (connected && !navigator.onLine) status('オフラインです。変更は端末内に残ります', 'warn');
      return;
    }
    if (busy) { rerun = true; return; }
    busy=true;
    $('cloudSyncNow').disabled=true;
    try {
      do {
        rerun=false;
        status('GitHubと同期中…');
        await once();
      } while (rerun && connected && navigator.onLine);
    } catch (error) {
      status('同期できませんでした：' + error.message, 'warn');
    } finally {
      busy=false;
      $('cloudSyncNow').disabled=!connected;
    }
  }
  function schedule() {
    if (!connected) return;
    clearTimeout(timer);
    timer=setTimeout(sync,2000);
    status('未同期の変更があります…', 'warn');
  }
  async function connect() {
    var input=$('cloudSyncToken');
    var supplied=input.value.trim();
    input.value='';
    if (!supplied || !/^github_pat_[\w-]+$/.test(supplied)) {
      status('Fine-grained tokenを入力してください', 'warn'); return;
    }
    token=supplied;
    status('非公開リポジトリへの接続を確認中…');
    $('cloudConnect').disabled=true;
    try {
      var info=await api('');
      if (!info.private || info.full_name !== OWNER+'/'+REPO) throw new Error('接続先は専用の非公開リポジトリだけにしてください');
      connected=true;
      $('cloudSyncNow').disabled=false;
      $('cloudConnect').textContent='再接続';
      await sync();
    } catch (error) {
      token='';connected=false;
      status('接続できません：'+error.message,'warn');
      $('cloudSyncNow').disabled=true;
    } finally {
      $('cloudConnect').disabled=false;
    }
  }
  function disconnect() {
    clearTimeout(timer);timer=null;
    token='';connected=false;rerun=false;
    $('cloudSyncNow').disabled=true;
    $('cloudConnect').textContent='接続して同期';
    status('未接続。端末内への保存は継続します');
  }
  if (!bridge || !$('cloudConnect')) return;
  $('cloudConnect').addEventListener('click',connect);
  $('cloudSyncNow').addEventListener('click',sync);
  $('cloudDisconnect').addEventListener('click',disconnect);
  window.addEventListener('online',schedule);
  document.addEventListener('visibilitychange',function(){if(!document.hidden)schedule();});
  window.addEventListener('focus',function(){if(connected)schedule();});
  window.hikidashiCloud = {
    onLocalSaved: function(reason){ if(reason !== 'クラウド同期') schedule(); }
  };
})();
