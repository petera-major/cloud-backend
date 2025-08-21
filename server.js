require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const axios = require("axios");
const cron = require("node-cron");
const mongoose = require("mongoose");

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function connectDB() {
  if (!MONGO_URI) {
    console.error(" Missing MONGO");
    process.exit(1);
  }
  await mongoose.connect(MONGO_URI, { autoIndex: true });
  console.log(" MongoDB connected");
}

const CheckSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    url: { type: String, required: true },
    method: { type: String, enum: ["GET", "HEAD"], default: "GET" },
    intervalMs: { type: Number, default: 60_000 },
    timeoutMs: { type: Number, default: 10_000 },
    expectedStatus: { type: Number, default: 200 },
    active: { type: Boolean, default: true },
    lastStatus: { type: String, default: "unknown" }, 
    lastLatencyMs: { type: Number, default: null },
    consecutiveFails: { type: Number, default: 0 },
    lastRunAt: { type: Date, default: null },
  },
  { timestamps: true }
);

const ResultSchema = new mongoose.Schema(
  {
    checkId: { type: mongoose.Schema.Types.ObjectId, ref: "Check", index: true },
    status: { type: String, enum: ["healthy", "unhealthy"], required: true },
    latencyMs: { type: Number, required: true },
    httpStatus: { type: Number },
    error: { type: String },
  },
  { timestamps: true }
);

const Check = mongoose.model("Check", CheckSchema);
const Result = mongoose.model("Result", ResultSchema);

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

app.get("/api/health", (_req, res) => res.json({ status: "healthy" }));

// Create a check
app.post("/api/checks", async (req, res) => {
  try {
    const check = await Check.create(req.body);
    res.status(201).json(check);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/checks", async (_req, res) => {
  const checks = await Check.find().sort({ createdAt: -1 });
  res.json(checks);
});

// Get check 
app.get("/api/checks/:id", async (req, res) => {
  const check = await Check.findById(req.params.id);
  if (!check) return res.status(404).json({ error: "Not found" });
  res.json(check);
});

app.delete("/api/checks/:id", async (req, res) => {
  await Check.findByIdAndDelete(req.params.id);
  res.status(204).end();
});

// Recent results for charts
app.get("/api/checks/:id/results", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 500);
  const results = await Result.find({ checkId: req.params.id })
    .sort({ createdAt: -1 })
    .limit(limit);
  res.json(results);
});

// quick summary (uptime information for last 24h)
app.get("/api/checks/:id/summary", async (req, res) => {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const results = await Result.find({ checkId: req.params.id, createdAt: { $gte: since } });
  const total = results.length || 1;
  const up = results.filter(r => r.status === "healthy").length;
  const uptimePct = Math.round((up / total) * 100);
  res.json({ window: "24h", totalChecks: total, up, uptimePct });
});

function dueToRun(check) {
  if (!check.lastRunAt) return true;
  return Date.now() - new Date(check.lastRunAt).getTime() >= check.intervalMs;
}

async function runOne(check) {
  const started = Date.now();
  try {
    const resp = await axios.request({
      url: check.url,
      method: check.method,
      timeout: check.timeoutMs,
      validateStatus: () => true,
    });
    const latency = Date.now() - started;
    const ok = resp.status === check.expectedStatus;

    await Result.create({
      checkId: check._id,
      status: ok ? "healthy" : "unhealthy",
      latencyMs: latency,
      httpStatus: resp.status,
      error: ok ? undefined : `Expected ${check.expectedStatus}, got ${resp.status}`,
    });

    check.lastLatencyMs = latency;
    check.lastStatus = ok ? "healthy" : "unhealthy";
    check.consecutiveFails = ok ? 0 : check.consecutiveFails + 1;
    check.lastRunAt = new Date();
    await check.save();

  } catch (err) {
    const latency = Date.now() - started;
    await Result.create({
      checkId: check._id,
      status: "unhealthy",
      latencyMs: latency,
      error: err.message,
    });
    check.lastLatencyMs = latency;
    check.lastStatus = "unhealthy";
    check.consecutiveFails += 1;
    check.lastRunAt = new Date();
    await check.save();
  }
}

function startRunner() {
  const every = process.env.CRON_EVERY_SECONDS
    ? `*/${Number(process.env.CRON_EVERY_SECONDS)} * * * * *`
    : "*/40 * * * * *";

  cron.schedule(every, async () => {
    const checks = await Check.find({ active: true });
    await Promise.all(
      checks.filter(dueToRun).map((c) => runOne(c))
    );
  });
}

const PORT = process.env.PORT || 4001;

(async () => {
  await connectDB();
  app.listen(PORT, () => console.log(` http://localhost:${PORT}`));
  startRunner();
})();
