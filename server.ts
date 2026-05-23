import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { createServer as createViteServer } from "vite";

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  const PORT = 3000;

  // Real-time communication state
  const channels = [
    { id: "ch-07", name: "CH-07 EMERGÊNCIA", activity: 0, ops: [] },
    { id: "ch-12", name: "CH-12 REGIÃO 7B", activity: 0, ops: [] },
    { id: "ch-22", name: "CH-22 TÁTICO", activity: 0, ops: [] },
    { id: "ch-31", name: "CH-31 SUPRIMENTOS", activity: 0, ops: [] },
    { id: "ch-99", name: "CH-99 BLACK SIGNAL", activity: 0, ops: [] },
  ];

  const operators = new Map();

  io.on("connection", (socket) => {
    console.log(`[CONNECT] User attached: ${socket.id}`);

    socket.on("join-network", ({ callsign }) => {
      operators.set(socket.id, { 
        id: socket.id, 
        callsign, 
        channel: null, 
        status: "IDLE", 
        silent: false 
      });
      socket.emit("network-synced", { channels, operators: Array.from(operators.values()) });
      io.emit("log-update", `[${new Date().toLocaleTimeString()}] OPERADOR ${callsign} CONECTADO`);
      io.emit("operators-update", Array.from(operators.values()));
    });

    socket.on("join-channel", (channelId) => {
      const op = operators.get(socket.id);
      if (op) {
        op.channel = channelId;
        socket.join(channelId);
        io.to(channelId).emit("log-update", `[${new Date().toLocaleTimeString()}] ${op.callsign} ENTROU NO CANAL ${channelId}`);
        io.emit("operators-update", Array.from(operators.values()));
      }
    });

    socket.on("ptt-start", () => {
      const op = operators.get(socket.id);
      if (op && op.channel) {
        op.status = "TX";
        socket.to(op.channel).emit("rx-start", { from: op.callsign });
        io.emit("operators-update", Array.from(operators.values()));
      }
    });

    socket.on("ptt-stop", () => {
      const op = operators.get(socket.id);
      if (op && op.channel) {
        op.status = "IDLE";
        socket.to(op.channel).emit("rx-stop");
        io.emit("operators-update", Array.from(operators.values()));
      }
    });

    socket.on("disconnect", () => {
      const op = operators.get(socket.id);
      if (op) {
        io.emit("log-update", `[${new Date().toLocaleTimeString()}] ${op.callsign} DESCONECTADO`);
        operators.delete(socket.id);
        io.emit("operators-update", Array.from(operators.values()));
      }
    });
  });

  // Vite integration
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`BLACK SIGNAL Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
