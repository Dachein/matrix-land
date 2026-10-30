import miniAppPackage from "../package.json";

export default {
  env: {
    TARO_APP_API_BASE: JSON.stringify(process.env.TARO_APP_API_BASE || "https://ai.example.invalid"),
    TARO_APP_USE_MOCKS: JSON.stringify(process.env.TARO_APP_USE_MOCKS || "0"),
    TARO_APP_VERSION: JSON.stringify(miniAppPackage.version)
  },
  defineConstants: {
    TARO_APP_API_BASE: JSON.stringify(process.env.TARO_APP_API_BASE || "https://ai.example.invalid"),
    TARO_APP_USE_MOCKS: JSON.stringify(process.env.TARO_APP_USE_MOCKS || "0"),
    TARO_APP_VERSION: JSON.stringify(miniAppPackage.version)
  },
  mini: {},
  h5: {}
};
