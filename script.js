// ============================================================================
// Frontend-only Bitcoin Trading Strategy Backtest System
// All backend functionality has been migrated to pure JavaScript
// ============================================================================

// Configuration
const BYBIT_API_BASE = "https://api.bybit.com/v5/market";
const TELEGRAM_API_BASE = "https://api.telegram.org/bot";

// Chart instance
let equityChart = null;

// DOM Elements
const backtestForm = document.getElementById("backtestForm");
const resultsSection = document.getElementById("resultsSection");
const metricsDisplay = document.getElementById("metricsDisplay");
const loadingIndicator = document.getElementById("loadingIndicator");
const errorMessage = document.getElementById("errorMessage");
const runBacktestBtn = document.getElementById("runBacktestBtn");
const telegramForm = document.getElementById("telegramForm");
const telegramSection = document.getElementById("telegramSection");
const testTelegramBtn = document.getElementById("testTelegramBtn");
const startMonitorBtn = document.getElementById("startMonitorBtn");
const stopMonitorBtn = document.getElementById("stopMonitorBtn");
const liveMonitorSection = document.getElementById("liveMonitorSection");

// Live monitoring state
let monitorInterval = null;
let isMonitoring = false;
let lastHourlyTimestamp = null; // Track last hourly K-line timestamp to detect new hour
let currentPosition = "none"; // Track current position state for hourly updates

// ============================================================================
// Data Fetcher (replaces data_fetcher.py)
// ============================================================================

class DataFetcher {
  /**
   * Fetch historical candlestick data from Bybit API
   */
  async fetchHistoricalData(
    symbol = "BTCUSDT",
    interval = "60",
    startTime = null,
    endTime = null
  ) {
    if (!startTime) {
      startTime = new Date("2022-01-01T00:00:00Z");
    }
    if (!endTime) {
      endTime = new Date();
    }

    let startTimeMs = startTime.getTime();
    let endTimeMs = endTime.getTime();
    let priceData = [];
    const gapInMilliseconds = 3600 * 1000; // 1 hour
    const limit = 1000;

    let currentEnd = endTimeMs;
    while (currentEnd > startTimeMs) {
      try {
        const url = `${BYBIT_API_BASE}/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}&end=${currentEnd}`;
        const response = await fetch(url);
        const result = await response.json();

        if (result.retCode === 0 && result.result && result.result.list) {
          const dataList = result.result.list;
          if (!dataList || dataList.length === 0) {
            break;
          }
          priceData.push(...dataList);
          currentEnd = currentEnd - gapInMilliseconds * limit;
        } else {
          console.error(`API Error: ${result.retMsg || "Unknown error"}`);
          break;
        }
      } catch (error) {
        console.error(`Error fetching data: ${error}`);
        break;
      }
    }

    if (priceData.length === 0) {
      throw new Error("Failed to fetch any data");
    }

    const processedData = priceData
      .map((item) => ({
        time: parseFloat(item[0]),
        close: parseFloat(item[4]),
      }))
      .filter((item) => item.time >= startTimeMs)
      .filter(
        (item, index, self) =>
          index === self.findIndex((t) => t.time === item.time)
      )
      .sort((a, b) => a.time - b.time);

    return processedData;
  }

  /**
   * Fetch real-time price from Bybit API
   */
  async fetchRealtimePrice(symbol = "BTCUSDT") {
    try {
      const url = `${BYBIT_API_BASE}/tickers?category=linear&symbol=${symbol}`;
      const response = await fetch(url);
      const result = await response.json();

      if (
        result.retCode === 0 &&
        result.result &&
        result.result.list &&
        result.result.list.length > 0
      ) {
        const price = parseFloat(result.result.list[0].lastPrice);
        return price;
      } else {
        throw new Error(result.retMsg || "Failed to fetch real-time price");
      }
    } catch (error) {
      console.error(`Error fetching real-time price: ${error}`);
      throw error;
    }
  }

  /**
   * Fetch recent historical data for Z-Score calculation (last N hours)
   * @param {boolean} useLastHourlyCandle - If true, use the last completed hourly candle (previous hour)
   */
  async fetchRecentData(
    symbol = "BTCUSDT",
    interval = "60",
    hours = 200,
    useLastHourlyCandle = true
  ) {
    let endTime = new Date();

    // If useLastHourlyCandle is true, use the last completed hourly candle
    // For example, if current time is 1:34, use 1:00 (previous hour)
    if (useLastHourlyCandle) {
      // Get the last completed hour (e.g., if now is 1:34, use 1:00)
      endTime = new Date(endTime);
      endTime.setMinutes(0);
      endTime.setSeconds(0);
      endTime.setMilliseconds(0);
      // Use the previous hour's end time
      endTime = new Date(endTime.getTime() - 1); // Subtract 1ms to get the end of previous hour
    }

    const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000);

    return await this.fetchHistoricalData(symbol, interval, startTime, endTime);
  }

  /**
   * Get the timestamp of the last completed hourly candle
   * Returns the start timestamp of the current hour (e.g., if now is 1:34, returns 1:00:00)
   * If now is exactly 2:00:00, returns 1:00:00 (previous hour)
   */
  getLastHourlyCandleTime() {
    const now = new Date();
    const currentHour = new Date(now);
    currentHour.setMinutes(0);
    currentHour.setSeconds(0);
    currentHour.setMilliseconds(0);

    // If we're exactly at the start of an hour (e.g., 2:00:00), use previous hour
    // Otherwise, use current hour's start time
    if (
      now.getMinutes() === 0 &&
      now.getSeconds() === 0 &&
      now.getMilliseconds() < 1000
    ) {
      // Exactly at hour start, use previous hour
      return new Date(currentHour.getTime() - 3600000).getTime();
    } else {
      // Use current hour's start time
      return currentHour.getTime();
    }
  }
}

// ============================================================================
// Backtest Engine (replaces backtest_engine.py)
// ============================================================================

class BacktestEngine {
  constructor() {}

  calculateZScore(data, window) {
    const result = data.map((item, index) => {
      if (index < window - 1) {
        return { ...item, mean: null, std: null, zscore: null };
      }

      const windowData = data
        .slice(index - window + 1, index + 1)
        .map((d) => d.close);
      const mean = windowData.reduce((a, b) => a + b, 0) / window;
      const variance =
        windowData.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
        window;
      const std = Math.sqrt(variance);
      const zscore = std !== 0 ? (item.close - mean) / std : 0;

      return { ...item, mean, std, zscore };
    });

    return result;
  }

  generateSignals(data, entryThreshold, exitThreshold, logicType, side) {
    // Initialize position array with NaN (matching Python logic)
    const position = new Array(data.length).fill(NaN);

    // First pass: set positions based on signal conditions
    for (let i = 0; i < data.length; i++) {
      const signal = data[i].zscore;
      if (signal === null || isNaN(signal)) {
        continue;
      }

      if (logicType === "trend") {
        if (side === "long") {
          if (signal >= entryThreshold) position[i] = 1; // Enter long
          if (signal <= exitThreshold) position[i] = 0; // Exit position
        } else if (side === "short") {
          if (signal >= entryThreshold) position[i] = 0; // Exit position
          if (signal <= exitThreshold) position[i] = -1; // Enter short
        } else if (side === "both") {
          if (signal >= entryThreshold) position[i] = 1; // Enter long
          if (signal <= exitThreshold) position[i] = -1; // Enter short
        }
      } else if (logicType === "fast") {
        if (side === "long") {
          position[i] = signal >= entryThreshold ? 1 : 0;
        } else if (side === "short") {
          position[i] = signal <= exitThreshold ? -1 : 0;
        } else if (side === "both") {
          if (signal >= entryThreshold) position[i] = 1; // Enter long
          if (signal <= exitThreshold) position[i] = -1; // Enter short
        }
      }
    }

    // Forward fill positions (matching pd.Series(position).ffill().fillna(0))
    let lastPosition = 0;
    for (let i = 0; i < position.length; i++) {
      if (isNaN(position[i])) {
        position[i] = lastPosition;
      } else {
        lastPosition = position[i];
      }
    }

    // Apply positions to result
    const result = data.map((item, index) => ({
      ...item,
      pos: position[index],
    }));

    return result;
  }

  backtest(data, window, entryThreshold, exitThreshold, logicType, side) {
    let df = this.calculateZScore(data, window);
    df = df.map((item) => ({ ...item, signal: item.zscore }));
    df = this.generateSignals(
      df,
      entryThreshold,
      exitThreshold,
      logicType,
      side
    );

    df = df.map((item, index) => {
      if (index === 0) {
        return { ...item, priceChange: 0 };
      }
      const priceChange =
        (item.close - df[index - 1].close) / df[index - 1].close;
      return { ...item, priceChange };
    });

    df = df.map((item, index) => {
      const posPrev = index === 0 ? 0 : df[index - 1].pos;
      return { ...item, posPrev };
    });

    df = df.map((item) => {
      const trades = Math.abs(item.posPrev - item.pos);
      return { ...item, trades };
    });

    df = df.map((item) => {
      const pnl = item.posPrev * item.priceChange; // No fees calculation
      return { ...item, pnl };
    });

    let cumulativePnl = 0;
    df = df.map((item) => {
      cumulativePnl += item.pnl;
      return { ...item, cumulativePnl };
    });

    let maxCumulativePnl = 0;
    df = df.map((item) => {
      maxCumulativePnl = Math.max(maxCumulativePnl, item.cumulativePnl);
      const drawdown = item.cumulativePnl - maxCumulativePnl;
      return { ...item, drawdown };
    });

    return df;
  }
}

// ============================================================================
// Metrics Calculator (replaces metrics.py)
// ============================================================================

class MetricsCalculator {
  constructor(interval = "1h") {
    this.annualizer =
      {
        "1m": 365 * 24 * 60,
        "5m": (365 * 24 * 60) / 5,
        "10m": (365 * 24 * 60) / 10,
        "15m": (365 * 24 * 60) / 15,
        "30m": (365 * 24 * 60) / 30,
        "60m": 365 * 24,
        "1h": 365 * 24,
        "4h": (365 * 24) / 4,
        "1d": 365,
      }[interval] || 365 * 24;
  }

  calculateWinRate(df) {
    const tradeEnds = [];
    let prevPos = 0;

    for (let i = 0; i < df.length; i++) {
      const currentPos = df[i].pos;
      if (prevPos !== 0 && currentPos === 0) {
        tradeEnds.push(i);
      }
      prevPos = currentPos;
    }

    if (tradeEnds.length === 0) {
      return 0.0;
    }

    let winningTrades = 0;
    for (const endIdx of tradeEnds) {
      let startIdx = endIdx - 1;
      const endPos = df[endIdx - 1].pos;
      while (startIdx >= 0 && df[startIdx].pos === endPos) {
        startIdx--;
      }
      startIdx++;

      if (startIdx < endIdx) {
        const tradePnl = df[endIdx].cumulativePnl - df[startIdx].cumulativePnl;
        if (tradePnl > 0) {
          winningTrades++;
        }
      }
    }

    return tradeEnds.length > 0
      ? (winningTrades / tradeEnds.length) * 100
      : 0.0;
  }

  calculateAllMetrics(df, window) {
    const validDf = df.filter(
      (item) => item.pnl !== null && !isNaN(item.pnl) && item.pnl !== undefined
    );

    if (validDf.length === 0) {
      return this.emptyMetrics();
    }

    const pnl = validDf.map((item) => item.pnl);
    const cumulativePnl = validDf.map((item) => item.cumulativePnl);
    const drawdown = validDf.map((item) => item.drawdown);
    const trades = validDf.reduce((sum, item) => sum + item.trades, 0);

    const meanPnl = pnl.reduce((a, b) => a + b, 0) / pnl.length;
    const variance =
      pnl.reduce((sum, val) => sum + Math.pow(val - meanPnl, 2), 0) /
      pnl.length;
    const stdPnl = Math.sqrt(variance);
    const sharpeRatio =
      pnl.length > 1 && stdPnl !== 0
        ? (meanPnl / stdPnl) * Math.sqrt(this.annualizer)
        : NaN;

    const maxDrawdown = Math.min(...drawdown);
    const annualizedReturn = pnl.length > 0 ? meanPnl * this.annualizer : 0.0;
    const calmarRatio =
      maxDrawdown !== 0 ? annualizedReturn / Math.abs(maxDrawdown) : NaN;
    const totalReturn = cumulativePnl[cumulativePnl.length - 1];
    const numTrades = Math.floor(trades);
    const effectivePeriods = validDf.length - window;
    const tradeFrequency =
      effectivePeriods > 0 ? (numTrades / effectivePeriods) * 100 : 0.0;
    const winRate = this.calculateWinRate(validDf);

    const startDate = new Date(validDf[0].time);
    const endDate = new Date(validDf[validDf.length - 1].time);
    const periodDays = Math.floor(
      (endDate - startDate) / (1000 * 60 * 60 * 24)
    );

    return {
      "Sharpe Ratio": isNaN(sharpeRatio) ? NaN : Number(sharpeRatio.toFixed(4)),
      "Calmar Ratio": isNaN(calmarRatio) ? NaN : Number(calmarRatio.toFixed(4)),
      "Max Drawdown": Number(maxDrawdown.toFixed(4)),
      "Annualized Return": Number(annualizedReturn.toFixed(4)),
      "Total Return": Number(totalReturn.toFixed(4)),
      "Number of Trades": numTrades,
      "Trade Frequency %": Number(tradeFrequency.toFixed(4)),
      "Win Rate %": Number(winRate.toFixed(2)),
      "Start Date": startDate.toISOString().replace("T", " ").substring(0, 19),
      "End Date": endDate.toISOString().replace("T", " ").substring(0, 19),
      "Period (days)": periodDays,
    };
  }

  emptyMetrics() {
    return {
      "Sharpe Ratio": NaN,
      "Calmar Ratio": NaN,
      "Max Drawdown": 0.0,
      "Annualized Return": 0.0,
      "Total Return": 0.0,
      "Number of Trades": 0,
      "Trade Frequency %": 0.0,
      "Win Rate %": 0.0,
      "Start Date": "N/A",
      "End Date": "N/A",
      "Period (days)": 0,
    };
  }
}

// ============================================================================
// Strategy Evaluator (replaces strategy_evaluator.py)
// ============================================================================

class StrategyEvaluator {
  constructor(
    minSharpeRatio = 1.0,
    minCalmarRatio = 1.0,
    maxDrawdownThreshold = -0.3,
    minTrades = 10
  ) {
    this.minSharpeRatio = minSharpeRatio;
    this.minCalmarRatio = minCalmarRatio;
    this.maxDrawdownThreshold = maxDrawdownThreshold;
    this.minTrades = minTrades;
  }

  evaluate(metrics) {
    const reasons = [];
    let passedChecks = 0;
    let totalChecks = 0;

    totalChecks++;
    const sharpe = metrics["Sharpe Ratio"];
    if (!isNaN(sharpe) && sharpe >= this.minSharpeRatio) {
      passedChecks++;
      reasons.push(
        `✓ Sharpe Ratio (${sharpe.toFixed(2)}) >= ${this.minSharpeRatio}`
      );
    } else {
      reasons.push(
        `✗ Sharpe Ratio (${isNaN(sharpe) ? "N/A" : sharpe.toFixed(2)}) < ${
          this.minSharpeRatio
        }`
      );
    }

    totalChecks++;
    const calmar = metrics["Calmar Ratio"];
    if (!isNaN(calmar) && calmar >= this.minCalmarRatio) {
      passedChecks++;
      reasons.push(
        `✓ Calmar Ratio (${calmar.toFixed(2)}) >= ${this.minCalmarRatio}`
      );
    } else {
      reasons.push(
        `✗ Calmar Ratio (${isNaN(calmar) ? "N/A" : calmar.toFixed(2)}) < ${
          this.minCalmarRatio
        }`
      );
    }

    totalChecks++;
    const mdd = metrics["Max Drawdown"];
    if (mdd >= this.maxDrawdownThreshold) {
      passedChecks++;
      reasons.push(
        `✓ Max Drawdown (${mdd.toFixed(4)}) >= ${this.maxDrawdownThreshold}`
      );
    } else {
      reasons.push(
        `✗ Max Drawdown (${mdd.toFixed(4)}) < ${this.maxDrawdownThreshold}`
      );
    }

    totalChecks++;
    const numTrades = metrics["Number of Trades"];
    if (numTrades >= this.minTrades) {
      passedChecks++;
      reasons.push(`✓ Number of Trades (${numTrades}) >= ${this.minTrades}`);
    } else {
      reasons.push(`✗ Number of Trades (${numTrades}) < ${this.minTrades}`);
    }

    const isRecommended = passedChecks === totalChecks;
    return [isRecommended, reasons];
  }
}

// ============================================================================
// Telegram Notifier (replaces telegram_notifier.py)
// ============================================================================

class TelegramNotifier {
  constructor(botToken, chatId) {
    this.botToken = botToken;
    this.chatId = chatId;
    this.baseUrl = `${TELEGRAM_API_BASE}${botToken}`;
  }

  /**
   * Send message to Telegram
   * @param {string} message - Message content
   * @returns {Promise<boolean>} Success status
   */
  async sendMessage(message) {
    try {
      const url = `${this.baseUrl}/sendMessage`;
      const params = new URLSearchParams({
        chat_id: this.chatId,
        text: message,
      });

      const response = await fetch(url, {
        method: "POST",
        body: params,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });

      const result = await response.json();
      return result.ok === true;
    } catch (error) {
      console.error("Error sending Telegram message:", error);
      return false;
    }
  }

  /**
   * Send test message
   * @returns {Promise<boolean>} Success status
   */
  async sendTestMessage() {
    const now = new Date();
    const timestamp = now.toLocaleString("en-US", {
      hour12: false,
    });

    const testMessage =
      "🤖 <b>Bitcoin Trading Strategy System</b>\n\n" +
      "✅ Telegram connection test successful!\n" +
      `⏰ Time: ${timestamp}\n\n` +
      "System is ready to monitor Bitcoin prices and send trading signals.";

    return await this.sendMessage(testMessage);
  }

  /**
   * Send trading signal
   * @param {string} signalType - 'entry_long', 'entry_short', 'exit_long', 'exit_short'
   * @param {number} price - Current price
   * @param {number} zscore - Current Z-Score
   * @param {number} entryThreshold - Entry threshold
   * @param {number} exitThreshold - Exit threshold
   * @returns {Promise<boolean>} Success status
   */
  async sendSignal(signalType, price, zscore, entryThreshold, exitThreshold) {
    const timestamp = new Date()
      .toISOString()
      .replace("T", " ")
      .substring(0, 19);

    let emoji = "⚪";
    let action = "Unknown Signal";
    let reason = "Unknown reason";

    if (signalType === "entry_long") {
      emoji = "🟢";
      action = "Long Entry Signal";
      reason = `Z-Score (${zscore.toFixed(
        2
      )}) >= ${entryThreshold} (price above mean)`;
    } else if (signalType === "entry_short") {
      emoji = "🔴";
      action = "Short Entry Signal";
      reason = `Z-Score (${zscore.toFixed(
        2
      )}) <= ${exitThreshold} (price below mean)`;
    } else if (signalType === "exit_long") {
      emoji = "🟡";
      action = "Long Exit Signal";
      reason = `Z-Score (${zscore.toFixed(
        2
      )}) <= ${exitThreshold} (price returning to mean)`;
    } else if (signalType === "exit_short") {
      emoji = "🟡";
      action = "Short Exit Signal";
      reason = `Z-Score (${zscore.toFixed(
        2
      )}) >= ${entryThreshold} (price returning to mean)`;
    }

    const message =
      `${emoji} <b>${action}</b>\n\n` +
      `💰 Price: $${price.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}\n` +
      `📊 Z-Score: ${zscore.toFixed(2)}\n` +
      `📈 Reason: ${reason}\n` +
      `⏰ Time: ${timestamp}`;

    return await this.sendMessage(message);
  }

  /**
   * Send hourly monitoring status (always sent once per hour)
   * @param {string} timeLabel - Hour label like "02:00"
   * @param {number} zscore - Current Z-Score
   * @param {number} price - Last hourly close price
   * @param {string} actionLabel - Action description (enter/exit/hold/none)
   * @param {"long"|"short"|"none"} positionLabel - Current position after evaluation
   * @param {string|null} signalType - Optional signal that fired this hour
   * @returns {Promise<boolean>}
   */
  /**
   * Send hourly monitoring summary (no separate signal message)
   */
  async sendHourlyUpdate(
    timeLabel,
    zscore,
    price,
    positionLabel,
    windowSize,
    entryThreshold,
    exitThreshold,
    dateLabel,
    strategyLogic,
    strategySide
  ) {
    const priceText =
      price !== null && !isNaN(price)
        ? `$${price.toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}`
        : "N/A";

    const positionText =
      positionLabel === "long"
        ? "Long"
        : positionLabel === "short"
        ? "Short"
        : "Flat";

    // 正确的 Z-Score 对比：long 用 entry，short 用 exit
    let zCompareText = "";
    if (positionLabel === "long") {
      zCompareText = `${zscore.toFixed(2)} ${
        zscore > entryThreshold ? ">" : "<"
      } ${entryThreshold}`;
    } else if (positionLabel === "short") {
      zCompareText = `${zscore.toFixed(2)} ${
        zscore < exitThreshold ? "<" : ">"
      } ${exitThreshold}`;
    } else {
      zCompareText = zscore.toFixed(2);
    }

    const message =
      `⏰ Hourly Monitor ${timeLabel} (${dateLabel})\n` +
      `💰 Price: ${priceText}\n` +
      `📚 Strategy: ${strategyLogic} ${strategySide}\n` +
      `🪟 Window: ${windowSize}\n` +
      `📏 Thresholds — Entry: ${entryThreshold}, Exit: ${exitThreshold}\n` +
      `📊 Z-Score: ${zCompareText}\n` +
      `📌 Position: ${positionText}`;

    return await this.sendMessage(message);
  }
}

// ============================================================================
// Chart Generator
// ============================================================================

function generateEquityCurve(data) {
  const canvas = document.getElementById("equityCurveChart");
  if (!canvas) {
    console.error("Canvas element not found");
    return;
  }

  const ctx = canvas.getContext("2d");

  if (equityChart) {
    equityChart.destroy();
  }

  const labels = data.map((item) => {
    const date = new Date(item.time);
    return date.toLocaleDateString();
  });
  const cumulativePnl = data.map((item) => item.cumulativePnl);

  equityChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        {
          label: "Equity Curve",
          data: cumulativePnl,
          borderColor: "#2563eb",
          backgroundColor: "rgba(37, 99, 235, 0.1)",
          borderWidth: 1.5,
          fill: false,
          tension: 0.1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        title: {
          display: true,
          text: "Equity Curve",
          font: {
            size: 14,
            weight: "bold",
          },
        },
        legend: {
          display: true,
        },
      },
      scales: {
        x: {
          title: {
            display: true,
            text: "Date",
          },
        },
        y: {
          title: {
            display: true,
            text: "Cumulative PnL",
          },
          grid: {
            color: "rgba(0, 0, 0, 0.1)",
          },
        },
      },
    },
  });
}

// ============================================================================
// Main Application Logic
// ============================================================================

const dataFetcher = new DataFetcher();
const backtestEngine = new BacktestEngine();
const metricsCalculator = new MetricsCalculator("1h");
const strategyEvaluator = new StrategyEvaluator();

function formatNumber(value, decimals = 2) {
  if (value === null || value === undefined || isNaN(value)) {
    return "N/A";
  }
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function showError(message) {
  if (errorMessage) {
    errorMessage.textContent = "❌ " + message;
    errorMessage.style.display = "block";
  }
  if (loadingIndicator) loadingIndicator.style.display = "none";

  setTimeout(() => {
    if (errorMessage) {
      errorMessage.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, 100);
}

function displayResults(data) {
  console.log("Displaying results:", data);
  const metrics = data.metrics;
  const evaluation = data.evaluation;

  const dataPointsBadge = document.getElementById("dataPointsBadge");
  if (dataPointsBadge && data.data_points) {
    dataPointsBadge.textContent = `${data.data_points.toLocaleString()} data points`;
  }

  const metricElements = {
    sharpeRatio: metrics["Sharpe Ratio"],
    calmarRatio: metrics["Calmar Ratio"],
    maxDrawdown: metrics["Max Drawdown"],
    annualizedReturn: metrics["Annualized Return"],
    totalReturn: metrics["Total Return"],
    numTrades: metrics["Number of Trades"],
    tradeFrequency: metrics["Trade Frequency %"],
    winRate: metrics["Win Rate %"],
  };

  const sharpeEl = document.getElementById("sharpeRatio");
  const calmarEl = document.getElementById("calmarRatio");
  const maxDrawdownEl = document.getElementById("maxDrawdown");
  const annualizedReturnEl = document.getElementById("annualizedReturn");
  const totalReturnEl = document.getElementById("totalReturn");
  const numTradesEl = document.getElementById("numTrades");
  const tradeFrequencyEl = document.getElementById("tradeFrequency");
  const winRateEl = document.getElementById("winRate");

  if (sharpeEl) sharpeEl.textContent = formatNumber(metricElements.sharpeRatio);
  if (calmarEl) calmarEl.textContent = formatNumber(metricElements.calmarRatio);
  if (maxDrawdownEl)
    maxDrawdownEl.textContent = formatNumber(metricElements.maxDrawdown, 4);
  if (annualizedReturnEl)
    annualizedReturnEl.textContent = formatNumber(
      metricElements.annualizedReturn,
      4
    );
  if (totalReturnEl)
    totalReturnEl.textContent = formatNumber(metricElements.totalReturn, 4);
  if (numTradesEl)
    numTradesEl.textContent = metricElements.numTrades.toLocaleString();
  if (tradeFrequencyEl)
    tradeFrequencyEl.textContent =
      formatNumber(metricElements.tradeFrequency, 2) + "%";
  if (winRateEl)
    winRateEl.textContent = formatNumber(metricElements.winRate, 2) + "%";

  const periodText = `${metrics["Start Date"]} to ${metrics["End Date"]} (${metrics["Period (days)"]} days)`;
  const backtestPeriodEl = document.getElementById("backtestPeriod");
  if (backtestPeriodEl) backtestPeriodEl.textContent = periodText;

  const evaluationResult = document.getElementById("evaluationResult");
  const evaluationReasons = document.getElementById("evaluationReasons");

  if (evaluation && evaluationResult) {
    if (evaluation.recommended) {
      evaluationResult.textContent =
        "✅ RECOMMENDED - This strategy meets all evaluation criteria";
      evaluationResult.className = "evaluation-result evaluation-recommended";
    } else {
      evaluationResult.textContent =
        "❌ NOT RECOMMENDED - This strategy does not meet all evaluation criteria";
      evaluationResult.className =
        "evaluation-result evaluation-not-recommended";
    }

    if (evaluationReasons && evaluation.reasons) {
      evaluationReasons.innerHTML = "";
      evaluation.reasons.forEach((reason) => {
        const li = document.createElement("li");
        li.textContent = reason;
        evaluationReasons.appendChild(li);
      });
    }
  }

  if (metricsDisplay) metricsDisplay.style.display = "block";

  // Show telegram section
  if (telegramSection) telegramSection.style.display = "block";
}

/**
 * Generate and download backtest report as CSV
 * @param {Array} backtestResults - Backtest results array
 * @param {Object} formData - Form data with strategy parameters
 */
function downloadBacktestReport(backtestResults, formData) {
  try {
    // Generate filename: {logic_type}_{side}_{window}_{entry_threshold}_{exit_threshold}——zscorebacktest.csv
    // Example: trend_long_130_2_-2——zscorebacktest.csv
    const logicType = formData.logic_type || "trend";
    const side = formData.side || "both";
    const window = formData.window || 190;
    const entryThreshold = formData.entry_threshold || 0.8;
    const exitThreshold = formData.exit_threshold || -0.3;

    // Format exit threshold for filename
    // If exit threshold is negative (e.g., -0.3), keep the negative sign
    // Format: trend_long_130_2_-2——zscorebacktest.csv
    const exitThresholdStr = exitThreshold.toString();

    const filename = `${logicType}_${side}_${window}_${entryThreshold}_${exitThresholdStr}——zscorebacktest.csv`;

    // CSV Headers (matching backtest_report.csv format)
    const headers = [
      "time",
      "close",
      "mean",
      "std",
      "zscore",
      "pos",
      "trades",
      "pnl",
      "cumulative_pnl",
      "drawdown",
    ];

    // Convert backtest results to CSV rows
    const csvRows = [headers.join(",")];

    for (const row of backtestResults) {
      const time = new Date(row.time)
        .toISOString()
        .replace("T", " ")
        .substring(0, 19);
      const close = row.close || "";
      const mean = row.mean !== null && row.mean !== undefined ? row.mean : "";
      const std = row.std !== null && row.std !== undefined ? row.std : "";
      const zscore =
        row.zscore !== null && row.zscore !== undefined ? row.zscore : "";
      const pos = row.pos !== null && row.pos !== undefined ? row.pos : "";
      const trades =
        row.trades !== null && row.trades !== undefined ? row.trades : "";
      const pnl = row.pnl !== null && row.pnl !== undefined ? row.pnl : "";
      const cumulativePnl =
        row.cumulativePnl !== null && row.cumulativePnl !== undefined
          ? row.cumulativePnl
          : "";
      const drawdown =
        row.drawdown !== null && row.drawdown !== undefined ? row.drawdown : "";

      const csvRow = [
        time,
        close,
        mean,
        std,
        zscore,
        pos,
        trades,
        pnl,
        cumulativePnl,
        drawdown,
      ].join(",");

      csvRows.push(csvRow);
    }

    // Create CSV content
    const csvContent = csvRows.join("\n");

    // Create blob and download
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);

    link.setAttribute("href", url);
    link.setAttribute("download", filename);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    console.log(`CSV report downloaded: ${filename}`);
  } catch (error) {
    console.error("Error generating CSV report:", error);
    // Don't show error to user, just log it
  }
}

function resetButton() {
  if (runBacktestBtn) {
    runBacktestBtn.disabled = false;
    const btnContent = runBacktestBtn.querySelector(".btn-content");
    const btnLoader = runBacktestBtn.querySelector(".btn-loader");
    if (btnContent) btnContent.style.display = "flex";
    if (btnLoader) btnLoader.style.display = "none";
  }
  if (loadingIndicator) loadingIndicator.style.display = "none";
}

// Initialize on page load
document.addEventListener("DOMContentLoaded", function () {
  console.log("Page loaded, initializing...");

  if (!backtestForm) {
    console.error("Backtest form not found!");
    return;
  }

  backtestForm.addEventListener("submit", handleBacktestSubmit);

  if (telegramForm) {
    telegramForm.addEventListener("submit", handleTelegramSubmit);
  }

  if (startMonitorBtn) {
    startMonitorBtn.addEventListener("click", handleStartMonitor);
  }

  if (stopMonitorBtn) {
    stopMonitorBtn.addEventListener("click", handleStopMonitor);
  }

  console.log("Initialization complete");
});

async function handleBacktestSubmit(e) {
  e.preventDefault();
  console.log("Backtest form submitted");

  // Check if monitoring is active
  if (isMonitoring) {
    alert("⚠️ Please stop monitoring first before running a new backtest!");
    return;
  }

  if (metricsDisplay) metricsDisplay.style.display = "none";
  if (errorMessage) errorMessage.style.display = "none";

  if (loadingIndicator) loadingIndicator.style.display = "block";
  if (resultsSection) resultsSection.style.display = "block";

  if (runBacktestBtn) {
    runBacktestBtn.disabled = true;
    const btnContent = runBacktestBtn.querySelector(".btn-content");
    const btnLoader = runBacktestBtn.querySelector(".btn-loader");
    if (btnContent) btnContent.style.display = "none";
    if (btnLoader) btnLoader.style.display = "flex";
  }

  const formData = {
    logic_type: document.getElementById("logic_type")?.value || "trend",
    side: document.getElementById("side")?.value || "both",
    window: parseInt(document.getElementById("window")?.value || 200),
    entry_threshold: parseFloat(
      document.getElementById("entry_threshold")?.value || 2.3
    ),
    exit_threshold: parseFloat(
      document.getElementById("exit_threshold")?.value || -1
    ),
  };

  console.log("Form data:", formData);

  if (
    isNaN(formData.window) ||
    formData.window <= 0 ||
    formData.window > 1000
  ) {
    showError("Window size must be between 1 and 1000");
    resetButton();
    return;
  }

  if (
    isNaN(formData.entry_threshold) ||
    formData.entry_threshold <= 0 ||
    formData.entry_threshold > 5
  ) {
    showError("Entry threshold must be between 0 and 5");
    resetButton();
    return;
  }

  if (
    isNaN(formData.exit_threshold) ||
    formData.exit_threshold >= 0 ||
    formData.exit_threshold < -5
  ) {
    showError("Exit threshold must be between -5 and 0");
    resetButton();
    return;
  }

  try {
    console.log("Fetching historical data...");
    const endTime = new Date();
    const startTime = new Date("2022-01-01T00:00:00Z");

    const priceData = await dataFetcher.fetchHistoricalData(
      "BTCUSDT",
      "60",
      startTime,
      endTime
    );

    console.log(`Fetched ${priceData.length} data points`);

    console.log("Running backtest...");
    const backtestResults = backtestEngine.backtest(
      priceData,
      formData.window,
      formData.entry_threshold,
      formData.exit_threshold,
      formData.logic_type,
      formData.side
    );

    console.log("Calculating metrics...");
    const metrics = metricsCalculator.calculateAllMetrics(
      backtestResults,
      formData.window
    );

    console.log("Evaluating strategy...");
    const [isRecommended, reasons] = strategyEvaluator.evaluate(metrics);

    console.log("Generating chart...");
    generateEquityCurve(backtestResults);

    const responseData = {
      success: true,
      metrics: metrics,
      evaluation: {
        recommended: isRecommended,
        reasons: reasons,
      },
      data_points: priceData.length,
    };

    displayResults(responseData);

    // Generate and download CSV report
    console.log("Generating CSV report...");
    downloadBacktestReport(backtestResults, formData);

    setTimeout(() => {
      if (resultsSection) {
        resultsSection.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, 100);
  } catch (error) {
    console.error("Error:", error);
    showError(error.message || "An error occurred. Please try again later.");
  } finally {
    resetButton();
  }
}

async function handleTelegramSubmit(e) {
  e.preventDefault();

  const telegramResult = document.getElementById("telegramResult");
  if (telegramResult) telegramResult.style.display = "none";

  // Disable button
  if (testTelegramBtn) {
    testTelegramBtn.disabled = true;
    const btnContent = testTelegramBtn.querySelector(".btn-content");
    const btnLoader = testTelegramBtn.querySelector(".btn-loader");
    if (btnContent) btnContent.style.display = "none";
    if (btnLoader) btnLoader.style.display = "flex";
  }

  const formData = {
    token: document.getElementById("telegram_token")?.value.trim() || "",
    chat_id: document.getElementById("telegram_chat_id")?.value.trim() || "",
  };

  // Validate inputs
  if (!formData.token || !formData.chat_id) {
    if (telegramResult) {
      telegramResult.style.display = "block";
      telegramResult.className = "result-message error-message";
      telegramResult.textContent = "❌ Token and Chat ID are required";
    }
    resetTelegramButton();
    return;
  }

  // Validate chat_id is numeric
  if (isNaN(formData.chat_id)) {
    if (telegramResult) {
      telegramResult.style.display = "block";
      telegramResult.className = "result-message error-message";
      telegramResult.textContent = "❌ Chat ID must be numeric";
    }
    resetTelegramButton();
    return;
  }

  try {
    // Test Telegram connection
    const notifier = new TelegramNotifier(formData.token, formData.chat_id);
    const success = await notifier.sendTestMessage();

    if (telegramResult) {
      telegramResult.style.display = "block";

      if (success) {
        telegramResult.className = "result-message success-message";
        telegramResult.textContent = "✅ Telegram connection test successful!";
        // Show live monitoring section after successful test
        if (liveMonitorSection) {
          liveMonitorSection.style.display = "block";
        }
      } else {
        telegramResult.className = "result-message error-message";
        telegramResult.textContent =
          "❌ Telegram connection test failed. Please check Token and Chat ID.";
      }

      // Scroll to result
      setTimeout(() => {
        telegramResult.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 100);
    }
  } catch (error) {
    console.error("Error:", error);
    if (telegramResult) {
      telegramResult.style.display = "block";
      telegramResult.className = "result-message error-message";
      telegramResult.textContent = "❌ Error: " + error.message;
    }
  } finally {
    resetTelegramButton();
  }
}

function resetTelegramButton() {
  if (testTelegramBtn) {
    testTelegramBtn.disabled = false;
    const btnContent = testTelegramBtn.querySelector(".btn-content");
    const btnLoader = testTelegramBtn.querySelector(".btn-loader");
    if (btnContent) btnContent.style.display = "flex";
    if (btnLoader) btnLoader.style.display = "none";
  }
}

// ============================================================================
// Live Monitoring Functions
// ============================================================================

/**
 * Check for trading signals and send notifications
 */
async function checkTradingSignal() {
  try {
    // Get current strategy parameters from form
    const logicType = document.getElementById("logic_type")?.value || "trend";
    const side = document.getElementById("side")?.value || "both";
    const window = parseInt(document.getElementById("window")?.value || 190);
    const entryThreshold = parseFloat(
      document.getElementById("entry_threshold")?.value || 0.8
    );
    const exitThreshold = parseFloat(
      document.getElementById("exit_threshold")?.value || -0.3
    );

    // Get Telegram credentials
    const token = document.getElementById("telegram_token")?.value.trim();
    const chatId = document.getElementById("telegram_chat_id")?.value.trim();

    if (!token || !chatId) {
      console.error("Telegram credentials not found");
      return;
    }

    // Get the timestamp of the last completed hourly candle
    // For example, if current time is 1:34, this returns 1:00:00
    const currentHourlyTimestamp = dataFetcher.getLastHourlyCandleTime();

    // Check if we have a new hourly candle (new hour has started)
    const hasNewHourlyCandle =
      lastHourlyTimestamp === null ||
      currentHourlyTimestamp > lastHourlyTimestamp;

    if (!hasNewHourlyCandle && lastHourlyTimestamp !== null) {
      // Already processed this hour; no need to recalc
      return;
    }

    // New hour detected or first check - fetch new data and calculate Z-Score
    console.log("Calculating Z-Score for new hour...");

    // Fetch recent hourly K-line data for Z-Score calculation
    // useLastHourlyCandle=true ensures we use the last completed hourly candle
    // For example, if now is 1:34, we use data up to 1:00 (previous hour)
    const recentData = await dataFetcher.fetchRecentData(
      "BTCUSDT",
      "60", // 60 = 1 hour interval
      window + 10,
      true // Use last completed hourly candle
    );

    if (recentData.length < window) {
      console.error("Not enough data for Z-Score calculation");
      updateMonitorStatus("Error: Not enough data", null, null, null);
      return;
    }

    // Calculate Z-Score for the last hourly data point
    // Z-Score is based on hourly K-line close prices, not real-time price
    const zscoreData = backtestEngine.calculateZScore(recentData, window);
    const lastData = zscoreData[zscoreData.length - 1];

    if (!lastData || lastData.zscore === null || isNaN(lastData.zscore)) {
      console.error("Z-Score calculation failed");
      updateMonitorStatus(
        "Error: Z-Score calculation failed",
        null,
        null,
        null
      );
      return;
    }

    // Use the close price from the last hourly K-line (not real-time price)
    // This ensures Z-Score and price are from the same hourly candle
    const currentPrice = lastData.close; // Hourly K-line close price
    const currentZScore = lastData.zscore; // Z-Score based on hourly data

    // Update the last hourly timestamp
    lastHourlyTimestamp = currentHourlyTimestamp;

    // Update UI with new hourly data
    // Format: "12/8/2025, 1:00 AM" (date and hour only, minutes always :00)
    const hourDate = new Date(currentHourlyTimestamp);
    const datePart = hourDate.toLocaleDateString("en-US", {
      month: "numeric",
      day: "numeric",
      year: "numeric",
    });
    const hour = hourDate.getHours();
    const ampm = hour >= 12 ? "PM" : "AM";
    const hour12 = hour % 12 || 12; // Convert to 12-hour format
    const formattedDateTime = `${datePart}, ${hour12}:00 ${ampm}`;
    const hourLabel = `${hour.toString().padStart(2, "0")}:00`;

    const year = hourDate.getFullYear();
    const month = String(hourDate.getMonth() + 1).padStart(2, "0");
    const day = String(hourDate.getDate()).padStart(2, "0");
    const dateLabel = `${year}-${month}-${day}`;
    updateMonitorStatus(
      `Monitoring`,
      currentPrice,
      currentZScore,
      formattedDateTime
    );

    // Detect signal and position/action for this hour (aligned with documentation)
    let signalType = null;
    let actionLabel = "No position (no new signal)";
    let nextPosition = currentPosition;

    if (logicType === "trend") {
      // Trend: long when Z > entry, short when Z < exit; otherwise hold previous
      if (side === "long") {
        nextPosition = currentZScore > entryThreshold ? "long" : "none";
      } else if (side === "short") {
        nextPosition = currentZScore < exitThreshold ? "short" : "none";
      } else {
        if (currentZScore > entryThreshold) {
          nextPosition = "long";
        } else if (currentZScore < exitThreshold) {
          nextPosition = "short";
        } else {
          nextPosition = currentPosition;
        }
      }
    } else if (logicType === "fast") {
      // Fast strategy rules
      // 1) Close shorts if Z > Exit
      if (
        (side === "short" || side === "both") &&
        currentPosition === "short" &&
        currentZScore > exitThreshold
      ) {
        nextPosition = "none";
        signalType = "exit_short";
      }
      // 2) Close longs if Z < Entry
      if (
        (side === "long" || side === "both") &&
        currentPosition === "long" &&
        currentZScore < entryThreshold
      ) {
        nextPosition = "none";
        signalType = signalType || "exit_long";
      }
      // 3) Open long if Z > Entry
      if (
        (side === "long" || side === "both") &&
        nextPosition === "none" &&
        currentZScore > entryThreshold
      ) {
        nextPosition = "long";
        signalType = "entry_long";
      }
      // 4) Open short if Z < Exit
      if (
        (side === "short" || side === "both") &&
        nextPosition === "none" &&
        currentZScore < exitThreshold
      ) {
        nextPosition = "short";
        signalType = "entry_short";
      }
      // If no changes were triggered above, keep current
      if (!signalType && nextPosition === "none") {
        nextPosition = currentPosition;
      }
    }

    // Determine signal if position changed (for trend or remaining fast cases)
    if (!signalType && nextPosition !== currentPosition) {
      if (currentPosition === "long" && nextPosition === "none") {
        signalType = "exit_long";
      } else if (currentPosition === "short" && nextPosition === "none") {
        signalType = "exit_short";
      } else if (nextPosition === "long") {
        signalType = "entry_long";
      } else if (nextPosition === "short") {
        signalType = "entry_short";
      }
    }

    // Human-readable action label
    if (nextPosition === "long" && currentPosition !== "long") {
      actionLabel = "Enter Long";
    } else if (nextPosition === "short" && currentPosition !== "short") {
      actionLabel = "Enter Short";
    } else if (currentPosition === "long" && nextPosition === "none") {
      actionLabel = "Close Long";
    } else if (currentPosition === "short" && nextPosition === "none") {
      actionLabel = "Close Short";
    } else if (nextPosition === "long") {
      actionLabel = "Hold Long";
    } else if (nextPosition === "short") {
      actionLabel = "Hold Short";
    } else {
      actionLabel = "No position (no new signal)";
    }

    currentPosition = nextPosition;

    // Always send hourly update (even without signal)
    const notifier = new TelegramNotifier(token, chatId);

    const hourlySent = await notifier.sendHourlyUpdate(
      hourLabel,
      currentZScore,
      currentPrice,
      currentPosition,
      window,
      entryThreshold,
      exitThreshold,
      dateLabel,
      logicType,
      side
    );

    if (hourlySent && signalType) {
      console.log(`Signal sent in hourly update: ${signalType}`);
    } else if (!hourlySent) {
      console.warn("Hourly Telegram message failed to send");
      updateMonitorStatus(
        "Warning: failed to send Telegram message (check token/chat ID).",
        currentPrice,
        currentZScore,
        formattedDateTime
      );
    }
  } catch (error) {
    console.error("Error checking trading signal:", error);
    updateMonitorStatus("Error: " + error.message, null, null, null);
  }
}

/**
 * Update monitor status display
 * @param {string} status - Status text
 * @param {number} price - Current price
 * @param {number} zscore - Current Z-Score
 * @param {string} dataDateTime - Date and time of the data source (e.g., "12/8/2025, 1:00 AM")
 */
function updateMonitorStatus(status, price, zscore, dataDateTime = null) {
  const statusText = document.getElementById("monitorStatusText");
  const lastCheckTime = document.getElementById("lastCheckTime");
  const currentPriceEl = document.getElementById("currentPrice");
  const currentZScoreEl = document.getElementById("currentZScore");

  if (statusText) {
    statusText.textContent = status;
  }

  // Display the data source time (hourly candle time), not current time
  if (lastCheckTime) {
    if (dataDateTime) {
      lastCheckTime.textContent = dataDateTime;
    } else {
      // Fallback to current time if no data time provided
      const now = new Date();
      lastCheckTime.textContent = now.toLocaleString();
    }
  }

  if (currentPriceEl) {
    if (price !== null && !isNaN(price)) {
      currentPriceEl.textContent = `$${price.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
    } else {
      currentPriceEl.textContent = "-";
    }
  }

  if (currentZScoreEl) {
    if (zscore !== null && !isNaN(zscore)) {
      currentZScoreEl.textContent = zscore.toFixed(2);
    } else {
      currentZScoreEl.textContent = "-";
    }
  }
}

/**
 * Start live monitoring
 */
async function handleStartMonitor() {
  const token = document.getElementById("telegram_token")?.value.trim();
  const chatId = document.getElementById("telegram_chat_id")?.value.trim();

  if (!token || !chatId) {
    alert("Please configure Telegram Bot Token and Chat ID first!");
    return;
  }

  if (isMonitoring) return;

  isMonitoring = true;
  lastHourlyTimestamp = null;
  currentPosition = "none";

  if (startMonitorBtn) startMonitorBtn.style.display = "none";
  if (stopMonitorBtn) stopMonitorBtn.style.display = "inline-flex";

  const monitorStatus = document.getElementById("monitorStatus");
  if (monitorStatus) {
    monitorStatus.style.display = "block";
    monitorStatus.className = "result-message success-message";
    monitorStatus.textContent =
      "🟢 Monitoring started. Z-Score is calculated at every hourly candle...";
  }

  // Run immediately
  await checkTradingSignal();

  // ⬅️NEW: Check every 10s for hour change
  let lastHour = new Date().getHours();

  monitorInterval = setInterval(async () => {
    if (!isMonitoring) return;

    const now = new Date();
    const currentHour = now.getHours();

    // detect hour change
    if (currentHour !== lastHour) {
      lastHour = currentHour;
      console.log("⏰ Hour changed → refreshing trading signal");
      await checkTradingSignal();
    }
  }, 10000); // check every 10 sec
}

/**
 * Stop live monitoring
 */
function handleStopMonitor() {
  if (!isMonitoring) {
    return;
  }

  isMonitoring = false;
  lastHourlyTimestamp = null; // Reset hourly timestamp

  // Clear interval
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }

  // Update UI
  if (startMonitorBtn) startMonitorBtn.style.display = "inline-flex";
  if (stopMonitorBtn) stopMonitorBtn.style.display = "none";
  const monitorWarning = document.getElementById("monitorWarning");
  if (monitorWarning) monitorWarning.style.display = "none";

  const monitorStatus = document.getElementById("monitorStatus");
  if (monitorStatus) {
    monitorStatus.style.display = "block";
    monitorStatus.className = "result-message error-message";
    monitorStatus.textContent = "⏹️ Monitoring stopped.";
  }

  updateMonitorStatus("Not monitoring", null, null);
  currentPosition = "none";

  console.log("Live monitoring stopped");
}
