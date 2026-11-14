const width = 260;
const playerX = 47;
const maxHealth = 4;
const jumpSpeed = 5.85;
const gravity = .32;
const musicStep = 60 / 132 / 2;
// Eight eighth-note slots per bar. Zero marks a rest.
const skyMusic = [
  [57, 64, 69, 0, 76, 74, 71, 69],
  [53, 65, 69, 72, 76, 0, 74, 72],
  [60, 64, 67, 0, 72, 76, 79, 76],
  [55, 62, 67, 71, 74, 0, 71, 67],
  [57, 64, 72, 0, 76, 81, 79, 76],
  [53, 65, 69, 72, 77, 76, 72, 69],
  [50, 62, 65, 69, 74, 0, 72, 69],
  [52, 64, 68, 71, 76, 74, 71, 68],
];
// Source rectangles exclude neighboring poses. The final coordinate marks the foot line.
const playerPoses = {
  jump:   [572, 47, 385, 410, 41, 405],
  hit:    [74, 556, 392, 381, 38, 932],
  over:   [562, 630, 389, 319, 30, 945],
  double: [1068, 518, 393, 438, 44, 884],
};
const runningFrames = [
  [79, 71, 383, 369, 37, 435],
  [574, 71, 383, 369, 37, 435],
  [1072, 71, 383, 369, 37, 435],
  [574, 71, 383, 369, 37, 435],
];
const duckFrame = [72, 712, 380, 237, 19, 944];
const heartFrame = [574, 579, 383, 369, 37, 943];
const cloudArt = ['....####....','..##llll##..','.##llllpll#.','#lllllppppp#','#lppppppvpp#','.##vvvvv###.','...#####....'];
const heartArt = ['.##.##.','#rr#rr#','#lrprr#','#rrrrr#','.#rrr#.','..#r#..','...#...'];
const heartPalette = { '#':'#493064', l:'#ffafbb', p:'#f9758d', r:'#f74b66' };
const bounds = {
  ice: { w: 31, h: 25, lift: 0 }, storm: { w: 36, h: 110, lift: 15 },
  tower: { w: 14, h: 62, lift: 0 }, star: { w: 11, h: 11 }, heart: { w: 14, h: 14 },
};
// Each star trail specifies [horizontal offset, centre height] relative to its obstacle.
const starTrails = {
  ice: [[-44, 9], [-28, 31], [-12, 51], [4, 61], [20, 64], [36, 55], [52, 39], [68, 18]],
  storm: [[-16, 7], [0, 7], [16, 7], [32, 7], [48, 7]],
  tower: [[-71, 12], [-55, 37], [-39, 54], [-23, 73], [-7, 95], [9, 110],
    [25, 117], [41, 111], [57, 96], [73, 73], [89, 45], [105, 15]],
};
const obstacleKinds = Object.keys(starTrails);
// Space reserved before a maneuver and after its center for landing at top speed.
const approach = { ice: 75, storm: 40, tower: 115 };
const recovery = { ice: 65, storm: 44, tower: 144 };

function createCourse() {
  let previous, center = 0, index = 0;
  return () => {
    const choices = obstacleKinds.filter(kind => kind !== previous);
    const kind = choices[Math.floor(Math.random() * choices.length)];
    center += (previous ? recovery[previous] + approach[kind] : 135) + 16 + Math.floor(Math.random() * 37);
    previous = kind;
    const entries = [
      [kind, center - bounds[kind].w / 2, bounds[kind].lift],
      ...starTrails[kind].map(([offset, height]) => ['star', center + offset - bounds.star.w / 2,
        height - bounds.star.h / 2]),
    ];
    if (++index % 4 === 0) entries.push(['heart', center + recovery[kind] + 4, 4]);
    return entries.sort((a, b) => a[1] - b[1]);
  };
}

// Collision rectangles use [left, right, bottom, top] in game units.
// The player's origin is at the centre of the feet. Obstacles use their sprite's lower left.
const uprightBody = [[-12, 12, 4, 18], [-8, 8, 18, 26], [-7, 7, 2, 4]];
const crouchedBody = [[-12, 12, 3, 10], [-6, 7, 10, 13]];
const obstacleBodies = {
  ice: [[4, 27, 8, 17], [10, 23, 17, 23], [13, 18, 2, 8]],
  storm: [[7, 17, 2, 25], [9, 23, 25, 42], [4, 28, 42, 69],
    [4, 34, 69, 86], [5, 30, 86, 100], [11, 29, 100, 108]],
  tower: [[2, 12, 1, 9], [3, 11, 9, 20], [3, 12, 20, 32], [3, 12, 32, 44],
    [3, 11, 44, 53], [2, 11, 53, 58], [5, 11, 58, 61]],
  star: [[-2, 13, -2, 13]],
  heart: [[0, 14, 0, 14]],
};

function touchesObject(object, distance, elevation, body) {
  const x = object.x - distance - playerX;
  return obstacleBodies[object.kind].some(([left, right, bottom, top]) =>
    body.some(([bodyLeft, bodyRight, bodyBottom, bodyTop]) =>
      x + left < bodyRight && x + right > bodyLeft &&
      object.lift + bottom < elevation + bodyTop && object.lift + top > elevation + bodyBottom));
}

function pixels(ctx, rows, x, y, scale, palette) {
  const { a, d } = ctx.getTransform();
  rows.forEach((row, r) => {
    const top = Math.round((y + r * scale) * d);
    const bottom = Math.round((y + (r + 1) * scale) * d);
    Array.from(row).forEach((token, c) => {
      if (!palette[token]) return;
      const left = Math.round((x + c * scale) * a);
      const right = Math.round((x + (c + 1) * scale) * a);
      ctx.fillStyle = palette[token];
      ctx.fillRect(left / a, top / d, (right - left) / a, (bottom - top) / d);
    });
  });
}

function scenery(ctx, height, ground, distance) {
  const sky = ctx.createLinearGradient(0, 0, 0, ground);
  sky.addColorStop(0, '#6949a3');
  sky.addColorStop(.55, '#a98cd9');
  sky.addColorStop(1, '#e4c8ed');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#e8d8f7';
  for (let index = 0; index < 18; index++) {
    const x = (index * 71 + 23 - Math.floor(distance * .05) % width + width) % width;
    const y = Math.round(ground * (.16 + (index * 19 % 47) / 100));
    ctx.fillRect(x, y, index % 3 === 0 ? 2 : 1, 2);
  }

  const layers = [
    { y: .28, scale: 3, stride: 89, speed: .12, palette: { '#':'#c6afe8', l:'#e8dbf8', p:'#d9c5f1', v:'#b29bdc' } },
    { y: .64, scale: 5, stride: 76, speed: .29, palette: { '#':'#c7aee7', l:'#f5e6fb', p:'#e7d3f6', v:'#c3a7e7' } },
    { y: .9, scale: 6, stride: 61, speed: .48, palette: { '#':'#c6a6e5', l:'#f7e8fa', p:'#e8d2f4', v:'#d1b2e9' } },
  ];
  for (const layer of layers) {
    const offset = Math.floor(distance * layer.speed) % layer.stride;
    for (let index = -1; index * layer.stride < width + layer.stride; index++) {
      const y = Math.round(ground * layer.y) + index % 2 * 9;
      pixels(ctx, cloudArt, index * layer.stride - offset, y, layer.scale, layer.palette);
    }
  }

  const trackTop = ground + 6;
  ctx.fillStyle = '#dec6f3';
  ctx.fillRect(0, trackTop, width, height - trackTop);
  ctx.fillStyle = '#f7e9fc';
  ctx.fillRect(0, trackTop, width, 5);
  const trackColors = { '#':'#ddc6f3', l:'#f8ecfc', p:'#eedcf9', v:'#c9afe8' };
  for (let x = -Math.floor(distance) % 36 - 36; x < width; x += 36) {
    pixels(ctx, cloudArt, x, trackTop + 3, 3, trackColors);
  }
}

const playerSprite = new Image();
const animationSprite = new Image();
const obstacleSheet = new Image();
const stormSprite = new Image();
const towerSprite = new Image();
const spriteFiles = [
  [playerSprite, '/mongtting-run-poses.png'],
  [animationSprite, '/mongtting-run-animation.png'],
  [obstacleSheet, '/cloud-run-obstacles.png'],
  [stormSprite, '/cloud-run-storm.png'],
  [towerSprite, '/cloud-run-tower.png'],
];
const obstacleSprites = {
  ice: [obstacleSheet, 664, 87, 560, 475],
  star: [obstacleSheet, 663, 672, 558, 524],
  storm: [stormSprite, 128, 31, 587, 1809],
  tower: [towerSprite, 196, 59, 416, 1822],
};

function drawObject(ctx, object, ground) {
  const { kind, lift } = object;
  const { w, h } = bounds[kind];
  const bottom = ground - lift + 6;
  if (kind === 'heart') {
    pixels(ctx, heartArt, object.x, bottom - h, 2, heartPalette);
    return;
  }
  const [image, sx, sy, sw, sh] = obstacleSprites[kind];
  if (!image.naturalWidth) return;
  const scale = Math.min(w / sw, h / sh);
  drawSprite(ctx, image, sx, sy, sw, sh,
    object.x + (w - sw * scale) / 2, bottom - sh * scale, scale);
}

function drawSprite(ctx, image, sx, sy, sw, sh, x, y, scale) {
  const { a, d } = ctx.getTransform();
  ctx.drawImage(image, sx, sy, sw, sh,
    Math.round(x * a) / a, Math.round(y * d) / d, sw * scale, sh * scale);
}

const landingSmile = new Image();
landingSmile.src = '/mongtting-smile.png';
let clicks = 0;
let smileTimer;
let gamePending = false;
document.addEventListener('click', event => {
  const mascot = event.target.closest('.landing-art .mascot');
  if (!mascot || gamePending) return;
  if (landingSmile.naturalWidth) {
    mascot.src = landingSmile.src;
    clearTimeout(smileTimer);
    smileTimer = setTimeout(() => { mascot.src = '/mascot.png'; }, 650);
  }
  clicks++;
  if (clicks === 5) {
    clicks = 0;
    gamePending = true;
    setTimeout(() => {
      gamePending = false;
      if (mascot.isConnected) openRun(mascot);
    }, 200);
  }
});

function openRun(trigger) {
  if (document.querySelector('.cloud-run')) return;
  const dialog = document.createElement('dialog');
  dialog.className = 'cloud-run';
  dialog.setAttribute('aria-label', '몽띵이 달리기');
  dialog.innerHTML = `
    <div class="cloud-run-stage">
      <canvas aria-hidden="true"></canvas>
      <div class="cloud-run-overlay">
        <div class="cloud-run-panel">
          <h2>몽띵이 달리기</h2>
          <p>별을 모으며 보랏빛 하늘을 달려요!<br>얼음 구름 <strong>점프</strong> · 먹구름 <strong>숙이기</strong><br>높은 구름 탑은 <strong>2단 점프</strong></p>
          <button class="cloud-run-start" autofocus disabled>게임 시작</button>
          <section class="cloud-run-leaderboard" hidden aria-label="게임 순위">
            <h3>TOP 20</h3>
            <p role="status"></p>
            <form hidden>
              <label>닉네임 <input name="nickname" required maxlength="20" autocomplete="nickname"></label>
              <button type="submit">기록 등록</button>
            </form>
            <ol></ol>
          </section>
        </div>
      </div>
      <div class="cloud-run-hud">
        <div class="cloud-run-health" role="img"></div>
        <div class="cloud-run-record"><output>0</output><span>0m</span></div>
        <button class="cloud-run-close" aria-label="게임 닫기">×</button>
      </div>
    </div>
    <div class="cloud-run-controls">
      <button data-duck disabled>▼ 숙이기</button><button data-jump disabled>▲ 점프</button>
    </div>`;
  document.body.append(dialog);
  dialog.showModal();

  const stage = dialog.querySelector('.cloud-run-stage');
  const canvas = stage.querySelector('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  let viewHeight = 125;
  const healthDisplay = stage.querySelector('.cloud-run-health');
  const hearts = Array.from({ length: maxHealth }, () => {
    const heart = document.createElement('span');
    heart.setAttribute('aria-hidden', 'true');
    healthDisplay.append(heart);
    return heart;
  });
  const score = stage.querySelector('output');
  const recordDistance = stage.querySelector('.cloud-run-record span');
  const overlay = stage.querySelector('.cloud-run-overlay');
  const title = overlay.querySelector('h2');
  const message = overlay.querySelector('p');
  const start = overlay.querySelector('button');
  const leaderboard = overlay.querySelector('.cloud-run-leaderboard');
  const rankStatus = leaderboard.querySelector('[role="status"]');
  const rankForm = leaderboard.querySelector('form');
  const nicknameInput = rankForm.elements.nickname;
  const saveButton = rankForm.querySelector('button');
  const rankList = leaderboard.querySelector('ol');
  const dateFormat = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeZone: 'Asia/Seoul' });
  let finishedRun;

  async function requestLeaderboard(record) {
    const response = await fetch('/api/game/leaderboard', record && {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
  }

  function showRecords(records) {
    rankList.replaceChildren(...records.map(record => {
      const row = document.createElement('li');
      row.textContent = `${record.nickname} · ${record.score}점 · ${record.distance}m · ${dateFormat.format(new Date(record.played_on))}`;
      return row;
    }));
  }

  async function checkRank(record) {
    rankStatus.textContent = '순위를 확인하고 있어요.';
    try {
      const { records } = await requestLeaderboard();
      if (finishedRun !== record) return;
      showRecords(records);
      const rank = 1 + records.filter(row => row.score > record.score ||
        (row.score === record.score && row.distance >= record.distance)).length;
      rankForm.hidden = rank > 20;
      rankStatus.textContent = rank <= 20 ? `현재 예상 ${rank}위예요. 닉네임을 등록하세요.` : '이번 기록은 TOP 20 밖이에요.';
    } catch {
      if (finishedRun === record) rankStatus.textContent = '순위를 불러오지 못했어요.';
    }
  }

  rankForm.addEventListener('submit', async event => {
    event.preventDefault();
    const record = finishedRun;
    if (!record || saveButton.disabled) return;
    saveButton.disabled = true;
    try {
      const { rank, records } = await requestLeaderboard({ ...record, nickname: nicknameInput.value });
      if (finishedRun !== record) return;
      showRecords(records);
      rankForm.hidden = true;
      rankStatus.textContent = rank ? `${rank}위에 등록했어요.` : '등록 전에 다른 기록이 올라와 TOP 20에서 밀렸어요.';
    } catch (error) {
      if (finishedRun === record) rankStatus.textContent = error.message || '기록을 등록하지 못했어요.';
    } finally {
      if (finishedRun === record) saveButton.disabled = false;
    }
  });
  Promise.all(spriteFiles.map(([sprite, url]) => {
    if (!sprite.naturalWidth) sprite.src = url;
    return sprite.decode();
  })).then(() => {
    start.disabled = false;
  }).catch(() => {
    message.textContent = '게임 이미지를 불러오지 못했어요. 게임을 닫고 다시 열어주세요.';
  });
  const close = stage.querySelector('.cloud-run-close');
  const duckButton = dialog.querySelector('[data-duck]');
  const jumpButton = dialog.querySelector('[data-jump]');
  let raf, last, running = false, duck = false, elevation = 0, velocity = 0, jumps = 0;
  let distance = 0, points = 0, health = maxHealth, immunity = 0, objects = [];
  let nextSection, upcoming, cursor, runTime = 0, heartEyes = 0, audio;
  let musicChannel, nextMusicTime, musicIndex;

  function tone(note, time, duration, volume, type = 'triangle', output = audio.destination, endNote = note) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const frequency = pitch => 440 * 2 ** ((pitch - 69) / 12);
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency(note), time);
    if (endNote !== note) oscillator.frequency.exponentialRampToValueAtTime(frequency(endNote), time + duration);
    gain.gain.setValueAtTime(.001, time);
    gain.gain.exponentialRampToValueAtTime(volume, time + .008);
    gain.gain.exponentialRampToValueAtTime(.001, time + duration);
    oscillator.connect(gain).connect(output);
    oscillator.start(time);
    oscillator.stop(time + duration);
  }

  function stopMusic() {
    musicChannel?.disconnect();
    musicChannel = undefined;
  }

  function scheduleMusic() {
    if (!running || audio?.state !== 'running') return;
    if (!musicChannel) {
      musicChannel = audio.createGain();
      musicChannel.connect(audio.destination);
      nextMusicTime = audio.currentTime + .03;
      musicIndex = 0;
    }
    nextMusicTime = Math.max(nextMusicTime, audio.currentTime);
    while (nextMusicTime < audio.currentTime + .12) {
      const bar = skyMusic[Math.floor(musicIndex / 8)];
      const beat = musicIndex % 8;
      if (beat > 0 && bar[beat]) tone(bar[beat], nextMusicTime, .19, .023, 'square', musicChannel);
      if (beat % 2 === 0) {
        tone(bar[0] - (beat % 4 === 0 ? 12 : 5), nextMusicTime, .27, .06, 'triangle', musicChannel);
      } else {
        tone(bar[2] + 12, nextMusicTime, .075, .016, 'sine', musicChannel);
      }
      nextMusicTime += musicStep;
      musicIndex = (musicIndex + 1) % (skyMusic.length * 8);
    }
  }

  function pickupSound(kind) {
    if (audio?.state !== 'running') return;
    const notes = kind === 'heart' ? [72, 76, 79] : [81, 88];
    notes.forEach((note, index) => tone(note, audio.currentTime + index * .045, .09, .047));
  }

  function impactSound() {
    if (audio?.state === 'running') tone(52, audio.currentTime, .17, .08, 'sawtooth', audio.destination, 29);
  }

  function gameOverSound() {
    if (audio?.state !== 'running') return;
    [72, 68, 65, 57].forEach((note, index) => {
      tone(note, audio.currentTime + .15 + index * .12, index === 3 ? .4 : .15, .065);
    });
  }

  function size() {
    const { width: cssWidth, height: cssHeight } = stage.getBoundingClientRect();
    if (!cssWidth || !cssHeight) return;
    viewHeight = cssHeight * width / cssWidth;
    const density = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(cssWidth * density);
    const pixelHeight = Math.round(cssHeight * density);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
  }
  size();
  const observer = new ResizeObserver(size);
  observer.observe(stage);

  function updateHearts() {
    healthDisplay.setAttribute('aria-label', '남은 하트 ' + health + '개, 최대 ' + maxHealth + '개');
    hearts.forEach((heart, index) => heart.classList.toggle('is-empty', index >= health));
  }
  updateHearts();

  function setDuck(value) {
    duck = running && value;
    duckButton.classList.toggle('is-down', duck);
  }
  function jump() {
    if (!running || jumps === 2) return;
    velocity = jumpSpeed;
    jumps++;
    setDuck(false);
  }
  function keys(event) {
    if (!running) return;
    if (['Space', 'ArrowUp', 'ArrowDown'].includes(event.code)) event.preventDefault();
    if (event.code === 'ArrowDown') setDuck(true);
    if (!event.repeat && ['Space', 'ArrowUp'].includes(event.code)) jump();
  }
  function release(event) {
    if (event.code === 'ArrowDown') setDuck(false);
  }
  function clearDuck() { setDuck(false); }

  function begin() {
    finishedRun = undefined;
    leaderboard.hidden = rankForm.hidden = true;
    rankForm.reset();
    saveButton.disabled = false;
    rankList.replaceChildren();
    stopMusic();
    distance = points = elevation = velocity = jumps = immunity = cursor = runTime = heartEyes = 0;
    nextSection = createCourse();
    upcoming = [['star', 0, 3], ['star', 16, 3], ['star', 32, 3]];
    if (window.AudioContext) {
      audio ??= new AudioContext();
      audio.resume().catch(() => {});
    }
    health = maxHealth;
    objects = [];
    updateHearts();
    score.value = 0;
    recordDistance.textContent = '0m';
    running = true;
    overlay.hidden = true;
    jumpButton.disabled = duckButton.disabled = false;
    jumpButton.focus({ preventScroll: true });
  }
  function end() {
    running = false;
    stopMusic();
    gameOverSound();
    clearDuck();
    jumpButton.disabled = duckButton.disabled = true;
    title.textContent = '게임 종료';
    message.textContent = points + '점 · ' + Math.floor(distance / 4) + 'm';
    start.textContent = '다시 시작';
    overlay.hidden = false;
    leaderboard.hidden = false;
    finishedRun = { runId: Array.from(crypto.getRandomValues(new Uint32Array(4)), part =>
      part.toString(16).padStart(8, '0')).join(''), score: points, distance: Math.floor(distance / 4) };
    checkRank(finishedRun);
    start.focus({ preventScroll: true });
  }

  function advance(dt) {
    const speed = 2.5 + Math.min(distance / 1600, 1.1);
    distance += speed * dt;
    elevation += (velocity - gravity * dt / 2) * dt;
    velocity -= gravity * dt;
    if (elevation <= 0) elevation = velocity = jumps = 0;
    immunity = Math.max(0, immunity - dt);
    heartEyes = Math.max(0, heartEyes - dt);
    if (!duck && elevation === 0) runTime += dt;

    while (true) {
      if (cursor === upcoming.length) {
        upcoming = nextSection();
        cursor = 0;
      }
      const [kind, position, lift] = upcoming[cursor];
      if (position > distance) break;
      objects.push({ kind, x: width + 8 + position, lift });
      cursor++;
    }
    const body = duck && elevation === 0 ? crouchedBody : uprightBody;
    for (const object of objects) {
      if (object.hit || !touchesObject(object, distance, elevation, body)) continue;
      if (object.kind === 'star' || object.kind === 'heart') {
        object.hit = true;
        points += object.kind === 'star' ? 10 : 100;
        pickupSound(object.kind);
        if (object.kind === 'heart') {
          health = Math.min(maxHealth, health + 1);
          heartEyes = 48;
        }
      } else if (immunity === 0) {
        object.hit = true;
        health--;
        impactSound();
        immunity = 65;
        if (health === 0) { end(); break; }
      }
    }
    objects = objects.filter(object => object.x + bounds[object.kind].w >= distance &&
      !(object.hit && ['star', 'heart'].includes(object.kind)));
    updateHearts();
    score.value = points;
    recordDistance.textContent = Math.floor(distance / 4) + 'm';
  }

  function frame(time) {
    const dt = Math.min(2, (time - (last ?? time)) / 16.667);
    last = time;
    for (let remaining = dt; running && remaining > 0; remaining--) {
      advance(Math.min(remaining, 1));
    }
    scheduleMusic();
    const ground = viewHeight - 53;
    ctx.setTransform(canvas.width / width, 0, 0, canvas.height / viewHeight, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    scenery(ctx, viewHeight, ground, distance);
    for (const object of objects) drawObject(ctx, { ...object, x: object.x - distance }, ground);
    const crouching = duck && !elevation;
    const pose = health === 0 ? 'over'
      : immunity > 43 ? 'hit'
      : crouching ? 'duck'
      : jumps === 2 ? 'double'
      : elevation > 0 ? 'jump' : 'run';
    if (playerSprite.naturalWidth &&
        (!immunity || pose === 'hit' || pose === 'over' || Math.floor(immunity / 5) % 2 === 0)) {
      const expression = heartEyes && pose === 'run';
      const animatedFrame = pose === 'run' || pose === 'duck';
      const [sx, sy, sw, sh, spriteHeight, foot] = pose === 'duck' ? duckFrame
        : expression ? heartFrame
        : pose === 'run' ? runningFrames[Math.floor(runTime / 6) % runningFrames.length]
        : playerPoses[pose];
      const scale = spriteHeight / sh;
      const sprite = animatedFrame ? animationSprite : playerSprite;
      if (sprite.naturalWidth) drawSprite(ctx, sprite, sx, sy, sw, sh,
        playerX - sw * scale / 2, ground + 6 - elevation - (foot - sy) * scale, scale);
    }
    raf = requestAnimationFrame(frame);
  }

  start.addEventListener('click', begin);
  close.addEventListener('click', () => dialog.close());
  jumpButton.addEventListener('click', jump);
  duckButton.addEventListener('pointerdown', event => {
    event.preventDefault();
    duckButton.setPointerCapture(event.pointerId);
    setDuck(true);
  });
  duckButton.addEventListener('lostpointercapture', clearDuck);
  duckButton.addEventListener('pointerup', clearDuck);
  duckButton.addEventListener('pointercancel', clearDuck);
  dialog.addEventListener('keydown', keys);
  dialog.addEventListener('keyup', release);
  window.addEventListener('blur', clearDuck);
  dialog.addEventListener('close', () => {
    finishedRun = undefined;
    window.removeEventListener('blur', clearDuck);
    observer.disconnect();
    cancelAnimationFrame(raf);
    stopMusic();
    audio?.close().catch(() => {});
    dialog.remove();
    if (trigger.isConnected && trigger.tabIndex >= 0) trigger.focus();
  }, { once: true });
  raf = requestAnimationFrame(frame);
}
