import { MIMO_FREE_BASE_URL } from "../shared.js";
export default {
  id: "mmf",
  hidden: true,
  priority: 200,
  display: {
    name: "MMF",
    icon: "hub",
    color: "#6366F1",
    textIcon: "MF",
  },
  category: "apikey",
  transport: {
    baseUrl: MIMO_FREE_BASE_URL,
    noAuth: true,
  },
  models: [
    { id: "mimo-auto", name: "MiMo Auto" },
  ],
};
