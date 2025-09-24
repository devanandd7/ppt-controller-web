import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

// Resolve WebSocket endpoint
// - In production on Vercel, host a dedicated WS relay and expose it as NEXT_PUBLIC_WS_URL (e.g., wss://your-relay.example.com/ws)
// - In local dev, fall back to same-origin Next.js API route /api/ws
const WS_ENDPOINT = typeof window !== "undefined"
  ? (process.env.NEXT_PUBLIC_WS_URL
      || `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/api/ws`)
  : "";

export default function Home() {
  const [token, setToken] = useState("");
  const [connected, setConnected] = useState(false);
  const [roleStatus, setRoleStatus] = useState({ desktop: false, web: false });
  const [micEnabled, setMicEnabled] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [log, setLog] = useState([]);
  const wsRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  // Touch/gesture refs
  const lastTapTimeRef = useRef(0);
  const touchStartRef = useRef({ x: 0, y: 0, t: 0, isDown: false });
  const micSourceRef = useRef(null);
  const rafRef = useRef(null);
  const lastKnockTimeRef = useRef(0);
  const pendingKnockRef = useRef(false);
  const knockTimerRef = useRef(null);
  const singleTapTimerRef = useRef(null);
  // QR scan refs
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const scanRafRef = useRef(null);
  const camStreamRef = useRef(null);

  useEffect(() => {
    return () => {
      disconnectWS();
      stopMic();
      stopScan();
    };
  }, []);

  function addLog(msg) {
    setLog((l) => [msg, ...l].slice(0, 100));
  }

  // Auto-start QR scan on mobile to help users see the camera preview immediately
  useEffect(() => {
    if (typeof navigator !== 'undefined') {
      const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
      if (isMobile && !connected && !token && !scanning) {
        startScan();
      }
    }
  }, [connected, token, scanning]);

  // QR scanning
  async function startScan() {
    if (scanning) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } });
      camStreamRef.current = stream;
      setScanning(true);
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();
      scanLoop();
      addLog("Camera started for QR scan");
    } catch (e) {
      addLog("Camera access denied or unavailable");
    }
  }

  function stopScan() {
    setScanning(false);
    if (scanRafRef.current) {
      cancelAnimationFrame(scanRafRef.current);
      scanRafRef.current = null;
    }
    const stream = camStreamRef.current;
    if (stream) {
      stream.getTracks().forEach(t => { try { t.stop(); } catch {} });
    }
    camStreamRef.current = null;
  }

  function scanLoop() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext('2d');
    const tick = () => {
      if (!scanning) return;
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (w && h) {
        canvas.width = w; canvas.height = h;
        ctx.drawImage(video, 0, 0, w, h);
        const imgData = ctx.getImageData(0, 0, w, h);
        const code = jsQR(imgData.data, w, h);
        if (code && code.data) {
          const val = String(code.data).trim();
          addLog(`QR detected: ${val}`);
          setToken(val);
          stopScan();
          if (!connected) {
            // small delay to ensure state update
            setTimeout(() => connectWS(), 50);
          }
          return;
        }
      }
      scanRafRef.current = requestAnimationFrame(tick);
    };
    scanRafRef.current = requestAnimationFrame(tick);
  }

  async function connectWS() {
    if (!token) {
      alert("Please enter a token");
      return;
    }
    try {
      // If we're using the same-origin API route, ping it first so its WS server initializes
      if (!process.env.NEXT_PUBLIC_WS_URL) {
        try { await fetch("/api/ws"); } catch {}
      }
      const url = `${WS_ENDPOINT}${WS_ENDPOINT.includes('?') ? '&' : '/?'}token=${encodeURIComponent(token)}&role=web`;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => {
        setConnected(true);
        addLog("WebSocket connected");
      };
      ws.onclose = () => {
        setConnected(false);
        setRoleStatus({ desktop: false, web: false });
        addLog("WebSocket disconnected");
      };
      ws.onerror = (e) => {
        addLog("WebSocket error");
      };
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === "status") {
            setRoleStatus({ desktop: !!data.desktop, web: !!data.web });
          } else if (data.type === "signal") {
            addLog(`Received ${data.name}`);
          } else if (data.type === "connected") {
            addLog(`Server acknowledged connection as ${data.role}`);
          } else if (data.type === "error") {
            addLog(`Server error: ${data.message}`);
          }
        } catch {}
      };
    } catch (e) {
      addLog("Failed to connect");
    }
  }

  function disconnectWS() {
    if (wsRef.current) {
      try { wsRef.current.close(); } catch {}
      wsRef.current = null;
    }
  }

  function sendSignal(name) {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "signal", name }));
      addLog(`Sent ${name}`);
    } else {
      addLog("Cannot send, not connected");
    }
  }

  // Gesture helpers (Pointer Events to avoid duplicate touch+mouse firing)
  function onPointerDown(e) {
    // Only consider primary button/pointer
    if (e.isPrimary === false) return;
    touchStartRef.current = { x: e.clientX, y: e.clientY, t: performance.now(), isDown: true };
  }

  function onPointerUp(e) {
    if (e.isPrimary === false) return;
    const start = touchStartRef.current;
    touchStartRef.current.isDown = false;
    const now = performance.now();
    const endX = e.clientX;
    const endY = e.clientY;

    const dx = endX - start.x;
    const dy = endY - start.y;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    // Detect horizontal swipe first
    const SWIPE_DIST = 60;
    const SWIPE_RATIO = 2; // horizontal dominance
    if (absDx > SWIPE_DIST && absDx > SWIPE_RATIO * absDy) {
      if (dx > 0) sendSignal("signal-1"); else sendSignal("signal-2");
      if (singleTapTimerRef.current) { clearTimeout(singleTapTimerRef.current); singleTapTimerRef.current = null; }
      lastTapTimeRef.current = 0;
      return;
    }

    // Tap / Double-tap
    const TAP_WINDOW = 300; // ms
    if (now - lastTapTimeRef.current < TAP_WINDOW) {
      if (singleTapTimerRef.current) { clearTimeout(singleTapTimerRef.current); singleTapTimerRef.current = null; }
      lastTapTimeRef.current = 0;
      sendSignal("signal-2");
    } else {
      lastTapTimeRef.current = now;
      singleTapTimerRef.current = setTimeout(() => {
        sendSignal("signal-1");
        singleTapTimerRef.current = null;
      }, TAP_WINDOW);
    }
  }

  async function startMic() {
    if (micEnabled) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      audioCtxRef.current = audioCtx;
      micSourceRef.current = source;
      analyserRef.current = analyser;
      setMicEnabled(true);
      addLog("Microphone enabled");
      loopDetect();
    } catch (e) {
      addLog("Microphone access denied");
    }
  }

  function stopMic() {
    setMicEnabled(false);
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch {}
      audioCtxRef.current = null;
    }
    if (knockTimerRef.current) {
      clearTimeout(knockTimerRef.current);
      knockTimerRef.current = null;
    }
  }

  function loopDetect() {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);

    const detect = () => {
      analyser.getByteTimeDomainData(data);
      // Simple energy/peak detection on time-domain signal
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128; // normalize -1..1
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);

      const THRESH = 0.2; // adjust if needed
      const NOW = performance.now();

      if (rms > THRESH) {
        if (!pendingKnockRef.current) {
          pendingKnockRef.current = true; // first knock in a possible series
          if (knockTimerRef.current) clearTimeout(knockTimerRef.current);
          knockTimerRef.current = setTimeout(() => {
            // Single knock timeout reached -> treat as 1 knock
            pendingKnockRef.current = false;
            sendSignal("signal-1");
          }, 250); // short window to avoid counting the same hit twice
          lastKnockTimeRef.current = NOW;
        } else {
          // A second peak detected while pending -> double knock
          const delta = NOW - lastKnockTimeRef.current;
          if (delta <= 1000) {
            if (knockTimerRef.current) {
              clearTimeout(knockTimerRef.current);
              knockTimerRef.current = null;
            }
            pendingKnockRef.current = false;
            sendSignal("signal-2");
          }
          lastKnockTimeRef.current = NOW;
        }
      }

      rafRef.current = requestAnimationFrame(detect);
    };
    rafRef.current = requestAnimationFrame(detect);
  }

  return (
    <div className="min-h-screen p-6 flex flex-col items-center gap-6">
      <h1 className="text-2xl font-semibold">Web Knock Controller</h1>

      {/* Top controls */}
      <div className="w-full max-w-md space-y-3">
        <label className="block text-sm font-medium">Token</label>
        <input
          className="w-full border rounded px-3 py-2"
          placeholder="Enter token from desktop app"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <div className="flex items-center gap-2 flex-wrap">
          {!connected ? (
            <button className="px-4 py-2 bg-blue-600 text-white rounded" onClick={connectWS}>Connect</button>
          ) : (
            <button className="px-4 py-2 bg-gray-600 text-white rounded" onClick={disconnectWS}>Disconnect</button>
          )}
          {!micEnabled ? (
            <button className="px-4 py-2 bg-green-600 text-white rounded" onClick={startMic}>Enable Mic</button>
          ) : (
            <button className="px-4 py-2 bg-yellow-600 text-white rounded" onClick={stopMic}>Disable Mic</button>
          )}
          <button className="px-4 py-2 bg-purple-600 text-white rounded" onClick={startScan} disabled={scanning}>
            {scanning ? "Scanning..." : "Scan QR"}
          </button>
        </div>
      </div>

      {/* Status line */}
      <div className="w-full max-w-md space-y-2">
        <div className="text-sm">Status: {connected ? "Connected" : "Disconnected"}</div>
        <div className="text-sm">Desktop joined: {roleStatus.desktop ? "Yes" : "No"}</div>
        <div className="text-sm">Website joined: {roleStatus.web ? "Yes" : "No"}</div>
      </div>

      {/* Touch pad shown only when connected */}
      {connected && (
        <div
          className="w-full max-w-3xl flex-1 min-h-[300px] border-2 border-dashed rounded-xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center select-none"
          style={{ touchAction: 'none' }}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
        >
          <div className="text-center text-sm opacity-70">
            <div>single tap / right swipe = Next</div>
            <div>double tap / left swipe = Previous</div>
          </div>
        </div>
      )}

      {/* QR scanning overlay (visible on both desktop/mobile). Shows live camera preview. */}
      {scanning && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-900 p-3 rounded-lg w-[92vw] max-w-md">
            <div className="flex justify-between items-center mb-2">
              <div className="font-medium">Scan QR Code</div>
              <button className="text-sm px-2 py-1 border rounded" onClick={stopScan}>Close</button>
            </div>
            <div className="relative w-full overflow-hidden rounded">
              <video
                ref={videoRef}
                className="w-full block"
                playsInline
                muted
                autoPlay
              ></video>
              {/* Scanning frame */}
              <div className="absolute inset-6 border-2 border-green-500 rounded"></div>
            </div>
            <div className="text-xs opacity-70 mt-2">
              Allow camera access. On mobile, rear camera is requested (environment). Point at the QR code from the desktop app.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
