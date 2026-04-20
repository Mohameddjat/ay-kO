import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    },
  });

  const PORT = 3000;

  // Game state
  const rooms: Record<string, any> = {};

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("join-room", (roomId) => {
      socket.join(roomId);
      if (!rooms[roomId]) {
        rooms[roomId] = { players: {}, status: 'waiting' };
      }
      rooms[roomId].players[socket.id] = {
        id: socket.id,
        x: 0,
        y: 0,
        angle: 0,
        gearRatio: 1,
        temp: 20,
        progress: 0,
      };
      
      const playerCount = Object.keys(rooms[roomId].players).length;
      if (playerCount >= 2 && rooms[roomId].status === 'waiting') {
        rooms[roomId].status = 'racing';
        io.to(roomId).emit("start-race");
      }

      io.to(roomId).emit("room-state", rooms[roomId]);
    });

    socket.on("player-lost", ({ roomId }) => {
      if (rooms[roomId] && rooms[roomId].status === 'racing') {
        rooms[roomId].status = 'finished';
        const remainingPlayers = Object.keys(rooms[roomId].players).filter(id => id !== socket.id);
        if (remainingPlayers.length > 0) {
          io.to(roomId).emit("game-over", { winnerId: remainingPlayers[0], reason: 'opponent exploded' });
        }
      }
    });

    socket.on("player-finished", ({ roomId }) => {
      if (rooms[roomId] && rooms[roomId].status === 'racing') {
        rooms[roomId].status = 'finished';
        io.to(roomId).emit("game-over", { winnerId: socket.id, reason: 'crossed finish line' });
      }
    });

    socket.on("update-state", ({ roomId, state }) => {
      if (rooms[roomId] && rooms[roomId].players[socket.id]) {
        rooms[roomId].players[socket.id] = {
          ...rooms[roomId].players[socket.id],
          ...state,
        };
        socket.to(roomId).emit("player-updated", rooms[roomId].players[socket.id]);
      }
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
      for (const roomId in rooms) {
        if (rooms[roomId].players[socket.id]) {
          const wasRacing = rooms[roomId].status === 'racing';
          delete rooms[roomId].players[socket.id];
          io.to(roomId).emit("player-left", socket.id);
          
          if (wasRacing && Object.keys(rooms[roomId].players).length === 1) {
            const winnerId = Object.keys(rooms[roomId].players)[0];
            rooms[roomId].status = 'finished';
            io.to(roomId).emit("game-over", { winnerId, reason: 'opponent left' });
          }

          if (Object.keys(rooms[roomId].players).length === 0) {
            delete rooms[roomId];
          }
        }
      }
    });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
