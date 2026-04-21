const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

// ------------------------------------
// HTTP SERVER (health = /)
// ------------------------------------
const server = http.createServer((req, res) => {
  const uptimeSeconds = Math.floor(process.uptime());
  const days = Math.floor(uptimeSeconds / 86400);
  const hours = Math.floor((uptimeSeconds % 86400) / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = uptimeSeconds % 60;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: `${days}d ${hours}h ${minutes}m ${seconds}s`,
    connections: wss.clients.size,
    activeMatches: rooms.size,
  }));
});

// ------------------------------------
// WEBSOCKET SERVER
// ------------------------------------
const wss = new WebSocket.Server({ server });

const waitingQueue = [];
const rooms = new Map();

// ------------------------------------
// HELPERS
// ------------------------------------
const send = (ws, payload) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
};

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function formatScores(room) {
  return room.players.map((p) => ({ name: p.name, score: p.score }));
}

function createRoom(player1, player2, totalQuestions, availableIds) {
  const roomId = generateRoomId();
  const questionIds = shuffle([...availableIds]).slice(0, totalQuestions);

  const room = {
    id: roomId,
    players: [
      { ws: player1.ws, socketId: player1.id, name: player1.name, score: 0 },
      { ws: player2.ws, socketId: player2.id, name: player2.name, score: 0 },
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

function sendToRoom(room, payload) {
  room.players.forEach((p) => send(p.ws, payload));
}

// ------------------------------------
// sendQuestion
// ------------------------------------
function sendQuestion(room) {
  const questionId = room.questionIds[room.currentQuestion];
  const currentPlayer = room.players[room.currentTurn];

  sendToRoom(room, {
    type: "question",
    questionIndex: room.currentQuestion,
    totalQuestions: room.totalQuestions,
    questionId,
    currentTurn: room.currentTurn,
    currentTurnName: currentPlayer.name,
    scores: formatScores(room),
  });
}

// ------------------------------------
// handleDisconnect
// ------------------------------------
function handleDisconnect(ws) {
  console.log(`❌ Desconectado: ${ws.socketId} (${ws.playerName || "?"})`);

  const queueIndex = waitingQueue.findIndex((s) => s.socketId === ws.socketId);
  if (queueIndex !== -1) {
    waitingQueue.splice(queueIndex, 1);
    console.log(`🗑️ ${ws.playerName} eliminado de la cola`);
    return;
  }

  if (ws.roomId) {
    const room = rooms.get(ws.roomId);
    if (room && room.status === "playing") {
      room.status = "finished";
      sendToRoom(room, {
        type: "opponent_left",
        message: `${ws.playerName || "Guest"}`,
        scores: formatScores(room),
      });
      rooms.delete(ws.roomId);
      console.log(`🗑️ Sala ${ws.roomId} eliminada`);
    }
  }
}

// ------------------------------------
// WS CONNECTION
// ------------------------------------
wss.on("connection", (ws) => {
  ws.socketId = Math.random().toString(36).substring(2, 10);
  console.log(`✅ Conectado: ${ws.socketId}`);

  ws.on("message", (raw) => {
    let msg;
    try{
      msg = JSON.parse(raw.toString());
    }catch{
      return;
    }

    // ── join_queue ────────────────────────────────────────────────────────────
    if( msg.type === "join_queue" ){
      const playerName = msg.name?.trim() || "Guest";
      ws.playerName = playerName;

      if( waitingQueue.length > 0 ){
        const opponent = waitingQueue.shift();

        const resolvedTotal = opponent.totalQuestions || 10;
        const resolvedIds = opponent.questionIds || [];

        const room = createRoom(
          { ws: opponent, id: opponent.socketId, name: opponent.playerName },
          { ws, id: ws.socketId, name: playerName },
          resolvedTotal,
          resolvedIds
        );

        opponent.roomId = room.id;
        ws.roomId = room.id;

        room.players.forEach((player) => {
          send(player.ws, {
            type: "game_start",
            roomId: room.id,
            totalQuestions: resolvedTotal,
            players: room.players.map((p) => ({
              name: p.name,
              score: p.score,
              socketId: p.socketId,
            })),
            currentTurn: room.currentTurn,
            scores: formatScores(room),
            mySocketId: player.socketId,
          });
        });

        sendQuestion(room);
      }else{
        ws.totalQuestions = msg.totalQuestions || 10;
        ws.questionIds = msg.questionIds || [];
        waitingQueue.push(ws);
        send(ws, {
          type: "waiting",
          message: "Buscando rival...",
          scores: [{ name: playerName, score: 0 }],
        });
        console.log(`⏳ ${playerName} en cola`);
      }
      return;
    }

    // ── answer ────────────────────────────────────────────────────────────────
    if( msg.type === "answer" ){
      const { answerId, isCorrect } = msg;
      const room = rooms.get(ws.roomId);
      if( !room || room.status !== "playing" ) return;

      const playerIndex = getPlayerIndex(room, ws.socketId);
      if( playerIndex !== room.currentTurn ){
        send(ws, { type: "error", message: "No es tu turno" });
        return;
      }

      const opponentIndex = playerIndex === 0 ? 1 : 0;
      const currentPlayer = room.players[playerIndex];
      const opponentPlayer = room.players[opponentIndex];

      if( isCorrect ){
        currentPlayer.score += 1;
      }else{
        opponentPlayer.score += 1;
      }

      room.currentQuestion += 1;

      if( room.currentQuestion >= room.totalQuestions ){
        room.status = "finished";

        const [p1, p2] = room.players;
        const winner = p1.score > p2.score ? p1.name : p2.score > p1.score ? p2.name : "Draw";

        sendToRoom(room, {
          type: "game_over",
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
      }else{
        room.currentTurn = opponentIndex;

        sendToRoom(room, {
          type: "answer_result",
          answeredBy: currentPlayer.name,
          answeredByIndex: playerIndex,
          isCorrect,
          answerId,
          scores: formatScores(room),
          nextTurn: room.currentTurn,
          nextTurnName: room.players[room.currentTurn].name,
        });

        const delay = isCorrect ? 2000 : 800;
        setTimeout(() => {
          if (rooms.has(room.id)) sendQuestion(room);
        }, delay);
      }
      return;
    }

    // ── option_selected ───────────────────────────────────────────────────────
    if( msg.type === "option_selected" ){
      const room = rooms.get(ws.roomId);
      if( !room || room.status !== "playing" ) return;

      const opponentIndex = getPlayerIndex(room, ws.socketId) === 0 ? 1 : 0;
      send(room.players[opponentIndex].ws, {
        type: "opponent_option_selected",
        option: msg.option,
      });
      return;
    }

    // ── leave ─────────────────────────────────────────────────────────────────
    if( msg.type === "leave" ){
      handleDisconnect(ws);
      ws.close();
    }
  });

  ws.on("close", () => handleDisconnect(ws));
});

// ------------------------------------
// KEEP ALIVE
// ------------------------------------
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  });
}, 30000);

// ------------------------------------
// START
// ------------------------------------
server.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});