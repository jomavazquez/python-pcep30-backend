const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// ─── Estado global ────────────────────────────────────────────────────────────

const waitingQueue = [];
const rooms = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function formatScores(room) {
  return room.players.map((p) => ({ name: p.name, score: p.score }));
}

function createRoom(player1, player2, totalQuestions, availableIds) {
  const roomId = generateRoomId();

  // Mezclar los IDs disponibles y coger los primeros totalQuestions
  const questionIds = shuffle([...availableIds]).slice(0, totalQuestions);

  const room = {
    id: roomId,
    players: [
      { socketId: player1.id, name: player1.name, score: 0 },
      { socketId: player2.id, name: player2.name, score: 0 },
    ],
    currentTurn: 0,
    currentQuestion: 0,
    questionIds,
    totalQuestions,
    status: "playing",
  };

  rooms.set(roomId, room);
  return room;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function getPlayerIndex(room, socketId) {
  return room.players.findIndex((p) => p.socketId === socketId);
}

// ─── Conexión ────────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log(`✅ Conectado: ${socket.id}`);

  // ── join_queue ──────────────────────────────────────────────────────────────
  socket.on("join_queue", ({ name, totalQuestions, questionIds }) => {
    const playerName = name?.trim() || "Invitado";
    socket.playerName = playerName;

    if (waitingQueue.length > 0) {
      const opponent = waitingQueue.shift();

      const resolvedTotal = opponent.totalQuestions || 10;
      const resolvedIds = opponent.questionIds || [];

      const room = createRoom(
        { id: opponent.id, name: opponent.playerName },
        { id: socket.id, name: playerName },
        resolvedTotal,
        resolvedIds
      );

      opponent.join(room.id);
      socket.join(room.id);
      opponent.roomId = room.id;
      socket.roomId = room.id;

      // Emitir individualmente para incluir mySocketId — cada jugador sabe quién es
      room.players.forEach((player) => {
        io.to(player.socketId).emit("game_start", {
          roomId: room.id,
          totalQuestions: resolvedTotal,
          players: room.players.map((p) => ({ name: p.name, score: p.score, socketId: p.socketId })),
          currentTurn: room.currentTurn,
          scores: formatScores(room),
          mySocketId: player.socketId,
        });
      });

      sendQuestion(room);
    } else {
      socket.totalQuestions = totalQuestions || 10;
      socket.questionIds = questionIds || [];
      waitingQueue.push(socket);
      socket.emit("waiting", {
        message: "Buscando rival...",
        scores: [{ name: playerName, score: 0 }],
      });
      console.log(`⏳ ${playerName} en cola con ${socket.totalQuestions}/${socket.questionIds.length} preguntas`);
    }
  });

  // ── answer ──────────────────────────────────────────────────────────────────
  socket.on("answer", ({ answerId, isCorrect }) => {
    const room = rooms.get(socket.roomId);
    if (!room || room.status !== "playing") return;

    const playerIndex = getPlayerIndex(room, socket.id);

    if (playerIndex !== room.currentTurn) {
      socket.emit("error", { message: "No es tu turno" });
      return;
    }

    const opponentIndex = playerIndex === 0 ? 1 : 0;
    const currentPlayer = room.players[playerIndex];
    const opponentPlayer = room.players[opponentIndex];

    if (isCorrect) {
      currentPlayer.score += 1;
    } else {
      opponentPlayer.score += 1;
    }

    room.currentQuestion += 1;

    if (room.currentQuestion >= room.totalQuestions) {
      room.status = "finished";

      const [p1, p2] = room.players;
      const winner =
        p1.score > p2.score ? p1.name : p2.score > p1.score ? p2.name : "Draw";

      io.to(room.id).emit("game_over", {
        scores: formatScores(room),
        winner,
        lastAnswer: {
          answeredBy: currentPlayer.name,
          answeredByIndex: playerIndex,
          isCorrect,
          answerId,
        },
      });

      console.log(`🏁 Sala ${room.id} terminada. Ganador: ${winner}`);
      rooms.delete(room.id);
    } else {
      room.currentTurn = opponentIndex;

      io.to(room.id).emit("answer_result", {
        answeredBy: currentPlayer.name,
        answeredByIndex: playerIndex,
        isCorrect,
        answerId,
        scores: formatScores(room),
        nextTurn: room.currentTurn,
        nextTurnName: room.players[room.currentTurn].name,
      });

      // 2s si acertó (confeti), 800ms si falló (flash rápido)
      const delay = isCorrect ? 2000 : 800;
      setTimeout(() => {
        if (rooms.has(room.id)) {
          sendQuestion(room);
        }
      }, delay);
    }
  });

  // ── option_selected: retransmitir la opción marcada al rival ────────────────
  socket.on("option_selected", ({ option }) => {
    const room = rooms.get(socket.roomId);
    if (!room || room.status !== "playing") return;
    socket.to(room.id).emit("opponent_option_selected", { option });
  });

  // ── leave / disconnect ──────────────────────────────────────────────────────
  socket.on("leave", () => handleDisconnect(socket));
  socket.on("disconnect", () => handleDisconnect(socket));
});

// ─── sendQuestion ─────────────────────────────────────────────────────────────

function sendQuestion(room) {
  const questionId = room.questionIds[room.currentQuestion];
  const currentPlayer = room.players[room.currentTurn];

  io.to(room.id).emit("question", {
    questionIndex: room.currentQuestion,
    totalQuestions: room.totalQuestions,
    questionId,
    currentTurn: room.currentTurn,
    currentTurnName: currentPlayer.name,
    scores: formatScores(room),
  });

}

// ─── handleDisconnect ─────────────────────────────────────────────────────────

function handleDisconnect(socket) {
  console.log(`❌ Desconectado: ${socket.id} (${socket.playerName || "?"})`);

  const queueIndex = waitingQueue.findIndex((s) => s.id === socket.id);
  if (queueIndex !== -1) {
    waitingQueue.splice(queueIndex, 1);
    console.log(`🗑️ ${socket.playerName} eliminado de la cola`);
    return;
  }

  if (socket.roomId) {
    const room = rooms.get(socket.roomId);
    if (room && room.status === "playing") {
      room.status = "finished";
      io.to(socket.roomId).emit("opponent_left", {
        message: `${socket.playerName || "Guest"}`,
        scores: formatScores(room),
      });
      rooms.delete(socket.roomId);
      console.log(`🗑️ Sala ${socket.roomId} eliminada`);
    }
  }
}

// ─── Health check ─────────────────────────────────────────────────────────────

app.get("/health", (req, res) =>
  res.json({ status: "ok", rooms: rooms.size, queue: waitingQueue.length })
);

// ─── Arrancar ─────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});