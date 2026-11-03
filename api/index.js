const { getApp } = require("../server");

module.exports = async function handler(request, response) {
  try {
    const app = await getApp();
    return app(request, response);
  } catch (error) {
    console.error("Unable to initialize the backend:", error);
    return response.status(500).json({
      message: "Backend initialization failed.",
    });
  }
};
