const express = require('express');
const path = require('path');
const { RoomServiceClient, AccessToken } = require('livekit-server-sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// LiveKit environment variables (configure in Render)
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_API_URL = process.env.LIVEKIT_API_URL;
const LIVEKIT_WS_URL = process.env.LIVEKIT_WS_URL;

if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_API_URL || !LIVEKIT_WS_URL) {
  console.error('Missing LiveKit environment variables');
  process.exit(1);
}

// Serve static CSS
app.use('/css', express.static(path.join(__dirname, 'public/css')));

// Home route: input room name
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>LiveKit Video App</title>
  <link rel="stylesheet" href="/css/styles.css" />
</head>
<body>
  <h1>LiveKit Video Call</h1>
  <div>
    <label for="roomInput">Room Name:</label>
    <input type="text" id="roomInput" placeholder="Enter room name" />
    <button id="joinBtn">Join Room</button>
  </div>
  <script>
    document.getElementById('joinBtn').addEventListener('click', () => {
      const room = document.getElementById('roomInput').value.trim();
      if (room) {
        window.location.href = '/room/' + encodeURIComponent(room);
      }
    });
  </script>
</body>
</html>
  `);
});

// Room route: video + audio
app.get('/room/:room', (req, res) => {
  const roomName = req.params.room;
  res.send(\`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Room: \${roomName}</title>
  <link rel="stylesheet" href="/css/styles.css" />
</head>
<body>
  <h1>Room: \${roomName}</h1>
  <div>
    <button id="joinBtn">Join Room</button>
    <button id="leaveBtn" disabled>Leave Room</button>
  </div>
  <div id="error" style="color:red; margin-top:1rem;"></div>
  <div class="videos">
    <div>
      <h2>Local Video</h2>
      <div id="localVideoContainer" class="video-container">
        <span>Not connected</span>
      </div>
      <audio id="localAudio" autoplay></audio>
    </div>
    <div>
      <h2>Remote Streams</h2>
      <div id="remoteContainer" class="video-container">
        <span>No participants</span>
      </div>
    </div>
  </div>
  <script type="module">
    import {
      connect,
      createLocalVideoTrack,
      createLocalAudioTrack
    } from 'https://unpkg.com/livekit-client/dist/livekit-client.browser.es.js';

    const roomName = "\${roomName}";
    const joinBtn = document.getElementById('joinBtn');
    const leaveBtn = document.getElementById('leaveBtn');
    const errorDiv = document.getElementById('error');
    const localVideoContainer = document.getElementById('localVideoContainer');
    const localAudioElement = document.getElementById('localAudio');
    const remoteContainer = document.getElementById('remoteContainer');
    let livekitRoom = null;

    function attachTrack(track, container) {
      if (track.kind === 'video') {
        const el = track.attach();
        el.style.width = '200px';
        el.style.height = 'auto';
        el.style.margin = '5px';
        container.innerHTML = '';
        container.appendChild(el);
      }
      if (track.kind === 'audio') {
        const el = track.attach();
        el.style.display = 'none';
        container.appendChild(el);
      }
    }

    function handleParticipant(participant) {
      participant.tracks.forEach(pub => {
        if (pub.isSubscribed && pub.track) {
          attachTrack(pub.track, remoteContainer);
        }
      });
      participant.on('trackSubscribed', track => {
        attachTrack(track, remoteContainer);
      });
    }

    async function joinRoom() {
      joinBtn.disabled = true;
      errorDiv.textContent = '';

      try {
        await fetch(\`/api/create-room?room=\${roomName}\`);
        const resp = await fetch(\`/api/token?room=\${roomName}\`);
        if (!resp.ok) throw new Error('Failed to fetch token');
        const { token, wsUrl } = await resp.json();

        livekitRoom = await connect(wsUrl, token, {
          audioCaptureDefaults: { echoCancellation: true },
          videoCaptureDefaults: { resolution: { width: 640, height: 480 } }
        });

        livekitRoom.participants.forEach(handleParticipant);
        livekitRoom.on('participantConnected', handleParticipant);

        const videoTrack = await createLocalVideoTrack();
        const audioTrack = await createLocalAudioTrack();

        await livekitRoom.localParticipant.publishTrack(videoTrack);
        await livekitRoom.localParticipant.publishTrack(audioTrack);

        localVideoContainer.innerHTML = '';
        const elV = videoTrack.attach();
        elV.style.width = '200px';
        elV.style.height = 'auto';
        localVideoContainer.appendChild(elV);

        localAudioElement.srcObject = new MediaStream([audioTrack.mediaStreamTrack]);
        localAudioElement.play().catch(e => {
          console.warn('Audio autoplay prevented:', e);
        });

        leaveBtn.disabled = false;
      } catch (e) {
        console.error('Error joining room:', e);
        errorDiv.textContent = 'Cannot connect to LiveKit: ' + e.message;
        joinBtn.disabled = false;
      }
    }

    leaveBtn.addEventListener('click', async () => {
      if (livekitRoom) {
        livekitRoom.shouldReconnect = false;
        await livekitRoom.disconnect();
        livekitRoom = null;

        localVideoContainer.innerHTML = '<span>Not connected</span>';
        localAudioElement.srcObject = null;
        remoteContainer.innerHTML = '<span>No participants</span>';
        leaveBtn.disabled = true;
        joinBtn.disabled = false;
      }
    });

    joinBtn.addEventListener('click', joinRoom);
  </script>
</body>
</html>
\`);
});

// API: create room
app.get('/api/create-room', async (req, res) => {
  const roomName = req.query.room;
  if (!roomName) return res.status(400).json({ error: 'Missing room parameter' });

  const client = new RoomServiceClient(
    LIVEKIT_API_URL,
    LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET
  );
  try {
    await client.createRoom({ name: roomName });
    return res.json({ created: true });
  } catch (e) {
    if (e.code === 409) return res.json({ created: false, note: 'Room already exists' });
    console.error(e);
    return res.status(500).json({ error: 'Failed to create room' });
  }
});

// API: get token
app.get('/api/token', (req, res) => {
  const roomName = req.query.room;
  if (!roomName) return res.status(400).json({ error: 'Missing room parameter' });

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: \`user-\${Math.floor(Math.random() * 10000)}\`
  });
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true
  });
  return res.json({ token: at.toJwt(), wsUrl: LIVEKIT_WS_URL });
});

app.listen(PORT, () => {
  console.log(\`Server listening on port \${PORT}\`);
});
