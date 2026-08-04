# 🤖 AI Trading Multi-Agent System (Simulation)

## 🎯 Mục tiêu
Xây dựng hệ thống AI agents:
- Tự động phân tích thị trường
- Tự quyết định BUY / SELL / HOLD (chỉ giả lập, không phải chơi thật)
- Hoạt động độc lập (không chia sẻ kiến thức)
- Có memory dài hạn để học và cải tiến

---

# 🧩 1. Kiến trúc tổng thể

Data Agent → Orchestrator → 5 Trading Agents → Simulation Engine → DB → Learning Loop

---

# ⚙️ 2. Thành phần hệ thống

## 2.1 Orchestrator Agent
- Điều phối toàn hệ thống
- Trigger agents khi có tín hiệu (ví dụ nhắc nhở Trading agents khi mã giảm xuống dưới mức cho phép)
- Theo dõi điều kiện thị trường

## 2.2 Data Agent
Đã có trong module tradingview_mcp (Đọc file SOURCE_INDEX.md để nắm cấu trúc source)
Thu thập dữ liệu:
- Giá cổ phiếu (OHLC)
- Chỉ số thị trường (VNINDEX…)
- Tin tức tài chính

## 2.3 Trading Agents (5 agents)
- Mỗi agent dùng model khác nhau
- Hoạt động độc lập
- Có strategy riêng

## 2.4 Simulation Engine
- Giả lập giao dịch
- Quản lý portfolio
- Tính PnL

## 2.5 Logging System
- Lưu quyết định giao dịch
- Lưu reasoning
- Lưu kết quả

## 2.6 Memory System
### 3 loại memory:
1. Short-term: context hiện tại
2. Long-term: lịch sử trade
3. Reflection: lessons learned

---

# 🔁 3. Luồng hoạt động

1. Fetch data  
2. Orchestrator check tín hiệu  
3. Trigger agents khi phiên mở cửa 
4. Agents chọn số lượng mã theo cấu hình và quyết định trade  
5. Simulation execution  
6. Log dữ liệu  
7. Learning loop  

---

# 🧠 4. Learning Loop

Trade → Log → Evaluate → Generate Lessons → Update Strategy

---

# 🗄️ 5. Database Schema

## Trades
{
  "agent_id": "GPT",
  "stock": "HPG",
  "action": "BUY",
  "price": 25,
  "reason": "...",
  "timestamp": "..."
}

## Lessons
{
  "agent_id": "Claude",
  "lesson": "Avoid high volatility stocks",
  "confidence": 0.8
}

---

# 🔍 6. Memory Retrieval (RAG)

Query → Similar trades → Inject vào prompt

---

# 🧰 7. Tech Stack

## Backend
- Python
- FastAPI

## AI Orchestration
- LangChain / LlamaIndex

## Database
- PostgreSQL
- Pinecone / Chroma

## Data Source
- Yahoo Finance
- Alpha Vantage
- News RSS / scraping

## Infra
- Docker
- Server local

---

# 📊 8. Metrics cần track
- PnL
- Win rate
- Sharpe ratio
- Max drawdown

---

# 🚀 9. MVP Roadmap

1. Data fetch
2. 1 agent
3. Simulation engine
4. Logging DB
5. 5 agents
6. Memory + learning
7. Orchestrator

---

# 🧠 Kết luận
Multi-agent AI hedge fund (giả lập)
