const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/register" && request.method === "POST") {
      try {
        const body = await request.json();
        const username = typeof body.username === "string" ? body.username.trim() : "";
        if (username.length < 2 || username.length > 20 || !/^[\p{L}\p{N}_ -]+$/u.test(username)) {
          return json({ error: "Name must be 2-20 characters and use letters, numbers, spaces, _ or -." }, 400);
        }

        const existing = await env.DB.prepare(
          "SELECT id FROM players WHERE username = ? COLLATE NOCASE"
        ).bind(username).first();

        if (existing) return json({ error: "This name is already taken. Choose another name." }, 409);

        const id = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO players (id, username) VALUES (?, ?)"
        ).bind(id, username).run();

        return json({ playerId: id, username }, 201);
      } catch (error) {
        return json({ error: "Could not register player." }, 500);
      }
    }

    if (url.pathname === "/api/scores" && request.method === "POST") {
      try {
        const body = await request.json();
        const playerId = typeof body.playerId === "string" ? body.playerId : "";
        const score = body.score;
        if (!playerId || !Number.isSafeInteger(score) || score < 0 || score > 10000000) {
          return json({ error: "Invalid player or score." }, 400);
        }

        const player = await env.DB.prepare(
          "SELECT id FROM players WHERE id = ?"
        ).bind(playerId).first();
        if (!player) return json({ error: "Player not found. Register your name again." }, 404);

        await env.DB.prepare(
          "INSERT INTO scores (player_id, score) VALUES (?, ?)"
        ).bind(playerId, score).run();

        return json({ saved: true });
      } catch (error) {
        return json({ error: "Could not save score." }, 500);
      }
    }

    if (url.pathname === "/api/leaderboard" && request.method === "GET") {
      try {
        const requested = Number.parseInt(url.searchParams.get("limit") || "20", 10);
        const limit = Number.isFinite(requested) ? Math.max(1, Math.min(50, requested)) : 20;
        const result = await env.DB.prepare(
          `SELECT p.username, MAX(s.score) AS best_score
           FROM scores s JOIN players p ON p.id = s.player_id
           GROUP BY p.id, p.username
           ORDER BY best_score DESC, p.username COLLATE NOCASE ASC
           LIMIT ?`
        ).bind(limit).all();
        return json({ leaderboard: result.results || [] });
      } catch (error) {
        return json({ error: "Could not load leaderboard." }, 500);
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "Not found." }, 404);
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const asset = await env.ASSETS.fetch(request);
      if (!asset.ok) return asset;
      let html = await asset.text();
      const addition = `
<style>
#onlinePlayerBox{display:flex;flex-direction:column;align-items:center;gap:8px;width:min(280px,90%)}
#onlinePlayerBox input{box-sizing:border-box;width:100%;padding:11px 14px;border:1px solid #777;border-radius:22px;font:inherit;text-align:center;background:#fff;color:#222}
#onlinePlayerBox button,.online-small-btn{font-size:14px;padding:9px 18px;box-shadow:0 3px 0 #c79a00}
#onlineStatus{font-size:12px;opacity:.85;min-height:16px}
#leaderboardPanel{position:absolute;inset:0;z-index:10;display:none;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:22px;background:rgba(5,5,20,.96);color:white;text-align:center}
#leaderboardPanel.show{display:flex}
#leaderboardRows{width:min(320px,95%);max-height:55%;overflow:auto;text-align:left}
.lb-row{display:flex;justify-content:space-between;padding:9px 12px;border-bottom:1px solid #ffffff25;font-size:15px}
.lb-row:first-child{color:#ffd23f;font-weight:800}
#leaderboardMessage{font-size:13px;opacity:.8}
</style>
<script>
(function(){
  const $=id=>document.getElementById(id);
  const start=$("startScreen"), over=$("overScreen"), game=$("game");
  if(!start||!over||!game)return;
  const box=document.createElement("div");
  box.id="onlinePlayerBox";
  box.innerHTML='<input id="onlineName" maxlength="20" autocomplete="nickname" placeholder="Choose your player name"><button id="saveOnlineName" class="online-small-btn">SAVE NAME</button><div id="onlineStatus">Save a name to submit scores to the leaderboard.</div><button id="openLeaderboard" class="online-small-btn">LEADERBOARD</button>';
  const startButton=$("startBtn");
  startButton.insertAdjacentElement("afterend",box);
  const panel=document.createElement("div");
  panel.id="leaderboardPanel";
  panel.innerHTML='<h2 style="color:#ffd23f">LEADERBOARD</h2><div id="leaderboardMessage">Loading...</div><div id="leaderboardRows"></div><button id="closeLeaderboard" class="online-small-btn">CLOSE</button>';
  game.appendChild(panel);

  const KEY_ID="skyClimberPlayerId", KEY_NAME="skyClimberPlayerName";
  const status=$("onlineStatus"), nameInput=$("onlineName");
  let playerId=localStorage.getItem(KEY_ID)||"";
  let playerName=localStorage.getItem(KEY_NAME)||"";
  if(playerName) nameInput.value=playerName;
  if(playerId&&playerName) status.textContent="Playing as "+playerName;

  $("saveOnlineName").addEventListener("click",async()=>{
    const username=nameInput.value.trim();
    if(username.length<2||username.length>20){status.textContent="Name must be 2-20 characters.";return;}
    status.textContent="Saving name...";
    try{
      const res=await fetch("/api/register",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username})});
      const data=await res.json();
      if(!res.ok) throw new Error(data.error||"Registration failed.");
      playerId=data.playerId; playerName=data.username;
      localStorage.setItem(KEY_ID,playerId); localStorage.setItem(KEY_NAME,playerName);
      status.textContent="Name saved: "+playerName;
    }catch(err){status.textContent=err.message;}
  });

  async function showLeaderboard(){
    panel.classList.add("show");
    $("leaderboardMessage").textContent="Loading...";
    $("leaderboardRows").innerHTML="";
    try{
      const res=await fetch("/api/leaderboard?limit=30");
      const data=await res.json();
      if(!res.ok) throw new Error(data.error||"Could not load leaderboard.");
      if(!data.leaderboard.length){$("leaderboardMessage").textContent="No scores yet. Be the first!";return;}
      $("leaderboardMessage").textContent="Best score for each player";
      $("leaderboardRows").innerHTML=data.leaderboard.map((p,i)=>'<div class="lb-row"><span>'+(i+1)+'. '+escapeHtml(p.username)+'</span><b>'+p.best_score+'</b></div>').join("");
    }catch(err){$("leaderboardMessage").textContent=err.message;}
  }
  function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
  $("openLeaderboard").addEventListener("click",showLeaderboard);
  $("closeLeaderboard").addEventListener("click",()=>panel.classList.remove("show"));
  const observer=new MutationObserver(async()=>{
    if(!over.classList.contains("show"))return;
    if(!playerId){status.textContent="Save your player name before your next run to record scores.";return;}
    const score=Number($("overScore").textContent)||0;
    status.textContent="Saving score...";
    try{
      const res=await fetch("/api/scores",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({playerId,score})});
      const data=await res.json();
      if(!res.ok)throw new Error(data.error||"Could not save score.");
      status.textContent="Score saved for "+playerName+"!";
    }catch(err){status.textContent=err.message;}
  });
  observer.observe(over,{attributes:true,attributeFilter:["class"]});
})();
</script>`;
      html = html.replace("</body>", addition + "</body>");
      const headers = new Headers(asset.headers);
      headers.delete("content-length");
      headers.set("cache-control", "no-store");
      headers.set("content-type", "text/html; charset=utf-8");
      return new Response(html, { status: asset.status, statusText: asset.statusText, headers });
    }

    return env.ASSETS.fetch(request);
  }
};
