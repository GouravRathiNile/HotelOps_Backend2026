const { pool } = require("../../db");
const { sql, getMssqlPool } = require("../../mssql");
const {retryableDatabaseResponse,} = require("../../utils/retryableDatabaseError");
const { formatDate } = require("../../utils/dateFormatter");
// ===============================================Pdf Helper
const { generatePdf, loadLogo } = require("../../utils/pdfHelper");
const PdfPrinter = require("pdfmake");
const path = require("path");
const  RGP_DETAIL_PDF_FONTS = {
  Roboto: {
    normal: path.join(process.cwd(), "fonts/Roboto-Regular.ttf"),
    bold: path.join(process.cwd(), "fonts/Roboto-Medium.ttf"),
    italics: path.join(process.cwd(), "fonts/Roboto-SemiBold.ttf"),
    bolditalics: path.join(process.cwd(), "fonts/Roboto-Bold.ttf"),
  },
};


// ========================================Response Helpers
const ok = (message, data, metadata) => ({
  success: true,
  message,
  ...(metadata !== undefined ? metadata : {}),
  ...(data !== undefined ? { data } : {}),
});
const fail = (message, statusCode = 400) => ({
  success: false,
  statusCode,
  message,
});
const databaseFailure = (error, action) => {
  console.error(`${action} Error:`, error.message);

  const retryResponse = retryableDatabaseResponse(error);

  if (retryResponse) return retryResponse;

  return {
    success: false,
    statusCode: 500,
    message: `Unable to ${action.toLowerCase()}.`,
  };
};
// ==============================================================================================CEO Dashboard 
// 1.=========================================================Top Drr Revenre Data
// ================================================== Helpers
// ===============================Date Filter Helper
const getDateRange = (filter) => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const dateParts = {};

  parts.forEach(({ type, value }) => {
    if (type !== "literal") dateParts[type] = Number(value);
  });

  const year = dateParts.year;
  const month = dateParts.month;
  const day = dateParts.day;

  const date = (y, m, d) =>
    new Date(Date.UTC(y, m - 1, d));

  const format = (d) => d.toISOString().slice(0, 10);

  const today = date(year, month, day);

  let currentFrom, currentTo, previousFrom, previousTo;

  switch (filter) {
    case "yesterday":
      currentFrom = date(year, month, day - 1);
      currentTo = currentFrom;
      previousFrom = date(
        currentFrom.getUTCFullYear(),
        currentFrom.getUTCMonth(),
        Math.min(
          currentFrom.getUTCDate(),
          date(currentFrom.getUTCFullYear(), currentFrom.getUTCMonth() + 1, 0).getUTCDate()
        )
      );
      previousTo = previousFrom;
      break;

    case "weekly":
      currentFrom = date(year, month, day - 7);
      currentTo = date(year, month, day - 1);
      previousFrom = date(year, month, day - 14);
      previousTo = date(year, month, day - 8);
      break;

    case "monthly":
      currentFrom = date(year, month, 1);
      currentTo = today;

      previousFrom = date(year, month - 1, 1);
      previousTo = date(
        year,
        month - 1,
        Math.min(
          day,
          date(year, month, 0).getUTCDate()
        )
      );
      break;

    case "yearly":
      currentFrom = date(year, 1, 1);
      currentTo = today;

      previousFrom = date(year - 1, 1, 1);
      previousTo = date(
        year - 1,
        month,
        Math.min(
          day,
          date(year - 1, month + 1, 0).getUTCDate()
        )
      );
      break;

    default:
      return null;
  }

  return {
    CurrentFromDate: format(currentFrom),
    CurrentToDate: format(currentTo),
    PreviousFromDate: format(previousFrom),
    PreviousToDate: format(previousTo),
  };
};
// ==============================Revenue Growth Helper
const calculateRevenue = (current, previous) => {
  const amount = Number(current || 0);
  const previousAmount = Number(previous || 0);

  const difference = amount - previousAmount;

  const growth =
    previousAmount === 0
      ? amount === 0 ? 0 : null
      : Number(
          ((difference / Math.abs(previousAmount)) * 100)
            .toFixed(2)
        );

  return {
    Amount: Number(amount.toFixed(2)),
    PreviousAmount: Number(previousAmount.toFixed(2)),
    Difference: Number(difference.toFixed(2)),
    GrowthPercentage: growth,
    Trend:
      growth === null ? "NEW" :
      growth > 0 ? "UP" :
      growth < 0 ? "DOWN" : "SAME",
  };
};
// ============================================================CEO Revenue Summary
const getCEORevenueSummary = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "monthly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail("Invalid revenue filter.", 400);
    }

    const rawOrganizationID = data.OrganizationID;
    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (typeof rawOrganizationID !== "string" && typeof rawOrganizationID !== "number" ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n)
    ) {
      return fail("OrganizationID must be a positive integer.", 400);
    }

    // ========================================================
    // 2. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 3. MSSQL Query
    // ========================================================

    const mssqlPool = await getMssqlPool();

    const result = await mssqlPool
      .request()
      .input("CurrentFrom", sql.Date, dates.CurrentFromDate)
      .input("CurrentTo", sql.Date, dates.CurrentToDate)
      .input("PreviousFrom", sql.Date, dates.PreviousFromDate)
      .input("PreviousTo", sql.Date, dates.PreviousToDate)
      .input("OrganizationID", sql.BigInt, organizationID || null)
      .query(`
        SELECT
          CASE
            WHEN EntryDate >= @CurrentFrom
             AND EntryDate < DATEADD(DAY, 1, @CurrentTo)
            THEN 'CURRENT'
            ELSE 'PREVIOUS'
          END AS PeriodType,

          COALESCE(SUM(FTD_Total_Revenue), 0)
            AS TotalRevenue,

          COALESCE(SUM(FTD_Room_Revenue), 0)
            AS RoomsRevenue,

          COALESCE(SUM(FTD_FB_Revenue), 0)
            AS FBRevenue,

          COALESCE(SUM(FTD_Club_Revenue), 0)
            AS ClubRevenue,

          COALESCE(SUM(FTD_OtherOD_Revenue), 0)
            AS OtherODRevenue

        FROM
          [DailyRevenueReport].[DailyRevenueReport_Tbl_Entry_Master]

        WHERE IsDeleted = 0
          AND (@OrganizationID IS NULL OR OrganizationID = @OrganizationID)
          AND (
            (
              EntryDate >= @CurrentFrom
              AND EntryDate < DATEADD(DAY, 1, @CurrentTo)
            )
            OR
            (
              EntryDate >= @PreviousFrom
              AND EntryDate < DATEADD(DAY, 1, @PreviousTo)
            )
          )

        GROUP BY
          CASE
            WHEN EntryDate >= @CurrentFrom
             AND EntryDate < DATEADD(DAY, 1, @CurrentTo)
            THEN 'CURRENT'
            ELSE 'PREVIOUS'
          END;
      `);

    // ========================================================
    // 4. Current / Previous Revenue
    // ========================================================

    const current = result.recordset.find(
      (row) => row.PeriodType === "CURRENT"
    ) || {};

    const previous = result.recordset.find(
      (row) => row.PeriodType === "PREVIOUS"
    ) || {};

    // ========================================================
    // 5. Response
    // ========================================================

    return ok(
      "CEO revenue summary fetched successfully.",
      {
        Filter: filter,

        DateRange: {
          Current: {
            FromDate: dates.CurrentFromDate,
            ToDate: dates.CurrentToDate,
          },
          Previous: {
            FromDate: dates.PreviousFromDate,
            ToDate: dates.PreviousToDate,
          },
        },

        TotalRevenue: calculateRevenue(
          current.TotalRevenue,
          previous.TotalRevenue
        ),

        RoomsRevenue: calculateRevenue(
          current.RoomsRevenue,
          previous.RoomsRevenue
        ),

        FBRevenue: calculateRevenue(
          current.FBRevenue,
          previous.FBRevenue
        ),

        ClubRevenue: calculateRevenue(
          current.ClubRevenue,
          previous.ClubRevenue
        ),

        OtherODRevenue: calculateRevenue(
          current.OtherODRevenue,
          previous.OtherODRevenue
        ),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO revenue summary"
    );
  }
};
// 2. ============================================================ Get CEO Occupancy
const getCEOOccupancy = async (data) => {
  try {
    // ========================================================
    // Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"].includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // Date Range (Existing Helper)
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // PostgreSQL Query
    // ========================================================

    const result = await pool.query(
      `
        SELECT
          entry.OrganizationID,
          organization.ShortName,
          ROUND(AVG(entry.Occupancy), 2) AS Occupancy

        FROM GuestMeet_Daily_Entry_Master AS entry
        LEFT JOIN Organization_Master AS organization
          ON organization.OrganizationID = entry.OrganizationID

        WHERE entry.IsDeleted = FALSE
          AND entry.EntryDate >= $1::DATE
          AND entry.EntryDate <= $2::DATE
          AND entry.Occupancy IS NOT NULL

        GROUP BY entry.OrganizationID, organization.ShortName

        ORDER BY entry.OrganizationID ASC;
      `,
      [
        dates.CurrentFromDate,
        dates.CurrentToDate,
      ]
    );

    // ========================================================
    // Response Mapping
    // ========================================================

    const occupancyData = result.rows.map((row) => ({
      OrganizationID: Number(row.organizationid),
      ShortName: row.shortname ?? null,
      Occupancy: Number(row.occupancy),
    }));

    // ========================================================
    // Response
    // ========================================================

    return ok(
      "CEO occupancy fetched successfully.",
      {
        Filter: filter,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        OccupancyData: occupancyData,
      }
    );

  } catch (error) {
    return databaseFailure(error, "Fetch CEO occupancy");
  }
};

// ============================================================
// Exports
// ============================================================
module.exports = {
  getCEORevenueSummary,
  getCEOOccupancy,
};

