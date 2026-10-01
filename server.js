import dotenv from "dotenv";
import express from "express";
import session from "express-session";
import bcrypt from "bcrypt";
import { v4 as uuidv4 } from "uuid";
import http from "http";
import { Server } from "socket.io";

dotenv.config();
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3400;
const users = [];
const onlineUsers = new Map();

app.use(express.json());
app.use(express.static("assets"));
app.use(express.urlencoded({ extended: true }));
app.set("view engine", "ejs");
app.use(
  session({
    secret: process.env.SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 60 * 60 * 1000,
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
    },
  }),
);

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login");
  }
  next();
}

io.on("connection", (socket) => {
  socket.on("register", (userID) => {
    onlineUsers.set(userID, socket.id);
    console.log(`User ${userID} connected with socket ID: ${socket.id}`);
    io.emit("onlineUsers", userID);
  });

  socket.on("transfer", (userID) => {
    for (const [userId, socketId] of onlineUsers.entries()) {
      if (socketId === socket.id && userId === userID) {
        io.to(socketId).emit({
          message: `You have received money from ${userID.name}`,
        });
      }
    }
  });

  socket.on("disconnect", () => {
    for (const [userId, socketId] of onlineUsers.entries()) {
      // Compare the stored socketId with the disconnected socket.id
      if (socketId === socket.id) {
        onlineUsers.delete(userId);
        console.log(
          `User ${userId} disconnected at ${new Date().toLocaleString()}`,
        );
        io.emit("userDisconnected", userId);
        break; // Exit the loop once the user is found and removed
      }
    }
  });
});

app.get("/dashboard", requireLogin, (req, res) => {
  const user = users.find((u) => u.id === req.session.user.id);
  return res.render("dashboard", {
    user,
  });
});

app.get("/success", requireLogin, (req, res) => {
  return res.render("auth/status", { user: req.session.user });
});

app.get("/login", (req, res) => {
  return res.render("auth/login", { page_name: "login" });
});

app.get("/register", (req, res) => {
  return res.render("auth/register", { page_name: "register" });
});

app.get("/profile/:id", requireLogin, (req, res) => {
  const user = users.find((u) => u.id === req.params.id);

  if (!user) {
    return res.status(404).send("cannot find user");
  }

  return res.render("profile", {
    user,
    viewer: req.session.user,
  });
});

app.get("/transfer_page/:id", requireLogin, (req, res) => {
  const user = users.find((u) => u.id === req.params.id);

  if (!user) {
    return res.status(404).send("User not found");
  }
  return res.render("transfer", {
    receiver: user,
    user: req.session.user,
    sender: req.session.user,
  });
});

app.post("/register", async (req, res) => {
  const { name, email, password, phone_num } = req.body;
  const salt = await bcrypt.genSalt();
  const hashedPassword = await bcrypt.hash(password, salt);
  const exitingUser = users.find((u) => u.name === name && u.email === email);

  if (!name || !email || !password) {
    return res.render("auth/register", {
      page_name: "register",
      e: "Fill out the fields",
    });
  } else if (exitingUser) {
    return res.render("auth/register", {
      page_name: "register",
      e: "User already exists",
    });
  } else {
    const user = {
      id: uuidv4(),
      name: name,
      email: email,
      password: hashedPassword,
      phone_num: phone_num,
      coins: 1000,
      transactionHistory: [],
    };
    users.push(user);

    console.log(users);
    return res.redirect("/login");
  }
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = users.find((u) => u.email === email);

  if (!email || !password) {
    return res.render("auth/login", {
      page_name: "login",
      e: "Fill out the fields",
    });
  } else if (user && (await bcrypt.compare(password, user.password))) {
    req.session.user = user;
    return res.redirect("/success");
  } else if (!user) {
    return res.render("auth/login", {
      page_name: "login",
      e: "Cannot find user",
    });
  } else {
    return res.render("auth/login", {
      page_name: "login",
      e: "Invalid credentials",
    });
  }
});

app.post("/search", requireLogin, (req, res) => {
  const { search_req } = req.body;
  //   const searchedUser = users.find((u) => u.name === search_req);
  if (!search_req || !search_req.trim()) {
    return res.json({
      error: "Input is Empty",
      users: [],
      query: "",
    });
  }

  const query = search_req.toLowerCase().trim();

  const matched_users = users.filter((user) => {
    return user.name.toLowerCase().includes(query);
  });

  if (matched_users.length === 0) {
    return res.json({
      error: "No User found",
      users: [],
      query,
    });
  }

  return res.json({
    users: matched_users,
    query,
    error: null,
  });
});

app.post("/transfer/:id", requireLogin, (req, res) => {
  const { transferAmount, reason } = req.body;

  const receiver = users.find((u) => u.id === req.params.id);

  const sender = users.find((u) => u.id === req.session.user.id);

  if (!sender || !receiver) {
    return res.json({
      error: "No sender or receiver",
    });
  }

  if (sender.id === receiver.id) {
    return res.json({
      error: "You cannot transfer to yourself",
    });
  }

  const amount = Number(transferAmount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.json({
      error: "Invalid transfer amount",
    });
  }

  if (amount > sender.coins) {
    return res.json({
      error: "Insufficient Funds",
    });
  }

  sender.coins -= amount;
  receiver.coins += amount;
  const receiverSocketId = onlineUsers.get(receiver.id);

  const transferDetails = {
    id: uuidv4(),
    transactionStatus: true,
    amount: amount,
    reason: reason,
    type: sender ? "Debit" : "Credit",
    senderName: sender.name,
    receiverName: receiver.name,
    receiverCoins: receiver.coins,
    error: null,
  };

  sender.transactionHistory.push(transferDetails);
  if (receiverSocketId) {
    console.log("Receiver socket:", receiverSocketId);
    console.log("Transfer details:", transferDetails);
    io.to(receiverSocketId).emit("transferReceived", transferDetails);
  }
  return res.json({
    ...transferDetails,
    senderCoins: sender.coins,
  });
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
