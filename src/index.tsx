/* @refresh reload */
import { render } from "solid-js/web";

import "./styles/reset.css";
import "./styles/app.css";
import "@xterm/xterm/css/xterm.css";

import { App } from "./App";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element not found");
}

render(() => <App />, root);
