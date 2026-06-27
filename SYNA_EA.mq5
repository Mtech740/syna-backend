//+------------------------------------------------------------------+
//|                                                  SYNA_EA.mq5     |
//|                            SYNA AI Trading Engine V4             |
//+------------------------------------------------------------------+
#property copyright "SYNA"
#property version   "4.0"
#property strict

// --- Input parameters ---
input string   API_URL        = "http://127.0.0.1:8080/api/mt5/signal";
input string   API_KEY        = "";   // Paste your API key from SYNA dashboard
input string   TRADE_SYMBOL    = "BTCUSD";
input double   LOT_SIZE        = 0.01;
input int      MAGIC_NUMBER    = 202411;
input int      SLEEP_SECONDS   = 5;

// --- Global variables ---
datetime lastSignalTime = 0;

//+------------------------------------------------------------------+
//| Expert initialization function                                   |
//+------------------------------------------------------------------+
int OnInit() {
   Print("SYNA EA started. API_KEY = ", API_KEY);
   if(StringLen(API_KEY) < 10) {
      Print("ERROR: Please set a valid API_KEY in EA inputs");
      return(INIT_FAILED);
   }
   if(SymbolInfoInteger(TRADE_SYMBOL, SYMBOL_SELECT) == 0) {
      Print("ERROR: Symbol ", TRADE_SYMBOL, " not found in Market Watch");
      return(INIT_FAILED);
   }
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| Expert deinitialization function                                 |
//+------------------------------------------------------------------+
void OnDeinit(const int reason) {
   Print("SYNA EA stopped. Reason: ", reason);
}

//+------------------------------------------------------------------+
//| Expert tick function                                             |
//+------------------------------------------------------------------+
void OnTick() {
   if(TimeCurrent() - lastSignalTime < SLEEP_SECONDS) return;
   lastSignalTime = TimeCurrent();

   string signal = GetSignal();
   if(signal == "") return;
   
   if(StringFind(signal, "BUY") != -1) {
      ExecuteTrade(ORDER_TYPE_BUY);
   } else if(StringFind(signal, "SELL") != -1) {
      ExecuteTrade(ORDER_TYPE_SELL);
   }
}

//+------------------------------------------------------------------+
//| Send HTTP GET request (correct MQL5 signature)                  |
//+------------------------------------------------------------------+
string GetSignal() {
   string url = API_URL + "?api_key=" + API_KEY + "&symbol=" + TRADE_SYMBOL;
   string headers = "";
   char postData[];
   char resultData[1024];
   string resultHeaders;
   int timeout = 5000;
   
   ResetLastError();
   
   // ✅ CORRECT WebRequest signature for MQL5
   int res = WebRequest("GET", url, headers, timeout, postData, resultData, resultHeaders);
   
   if(res == -1) {
      Print("WebRequest error: ", GetLastError());
      return "";
   }
   
   string response = CharArrayToString(resultData);
   Print("Signal: ", response);
   return response;
}

//+------------------------------------------------------------------+
//| Execute market order                                            |
//+------------------------------------------------------------------+
void ExecuteTrade(ENUM_ORDER_TYPE type) {
   if(PositionSelect(TRADE_SYMBOL)) {
      Print("Already have position on ", TRADE_SYMBOL);
      return;
   }
   
   MqlTradeRequest req = {};
   MqlTradeResult  res = {};
   req.action = TRADE_ACTION_DEAL;
   req.symbol = TRADE_SYMBOL;
   req.volume = LOT_SIZE;
   req.type   = type;
   req.type_filling = ORDER_FILLING_FOK;
   req.deviation = 10;
   req.magic = MAGIC_NUMBER;
   
   double price = (type == ORDER_TYPE_BUY) ? SymbolInfoDouble(TRADE_SYMBOL, SYMBOL_ASK)
                                           : SymbolInfoDouble(TRADE_SYMBOL, SYMBOL_BID);
   req.price = price;
   
   if(OrderSend(req, res)) {
      Print("Order executed: ", res.order);
   } else {
      Print("Order failed: ", GetLastError());
   }
}