const DashboardHandler = async (message) => {
  switch (message.action) {
    // Add Dashboard actions here as service methods are implemented.
    default:
      return {
        success: false,
        statusCode: 400,
        message: "Invalid Dashboard action.",
      };
  }
};

module.exports = DashboardHandler;
