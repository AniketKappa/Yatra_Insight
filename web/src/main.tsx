import { StrictMode, Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { RouterProvider } from "./lib/router";
import { StoreProvider } from "./lib/store";
import { ToastProvider } from "./components/ui";

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="page" role="alert">
          <div className="error-box">
            <div>
              <strong>Something went wrong while showing this page.</strong>
              <p style={{ marginTop: 4 }}>{this.state.error.message}</p>
              <button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }} onClick={() => window.location.assign("/")}>Back to overview</button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Boundary>
      <RouterProvider>
        <StoreProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </StoreProvider>
      </RouterProvider>
    </Boundary>
  </StrictMode>,
);
