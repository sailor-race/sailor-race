import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import DisplayPage from "./pages/DisplayPage.js";
import AdminPage from "./pages/AdminPage.js";

// HashRouter: الروابط تصير /#/display و /#/admin
// ضروري على GitHub Pages — بدون سيرفر يعيد توجيه الطلبات،
// الروابط المباشرة و Refresh ستُعطي 404 مع BrowserRouter.
export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/display" element={<DisplayPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="*" element={<Navigate to="/display" replace />} />
      </Routes>
    </HashRouter>
  );
}
