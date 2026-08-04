import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

function App() {
  return <main><h1>ProofBlade / 证锋</h1><p>调试数据面已连接，界面构建中。</p></main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
