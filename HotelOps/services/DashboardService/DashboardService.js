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
// ==============================================================================================CEO Dashboard 
// 1.=========================================================Top Drr Revenre Data
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
// ===============================================================CEO Revenue Summary
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
// 1.1============================================================CEO Revenue Summary Adr and Other
const getCEORevenuePerformance = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range (Existing Helper)
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 5. MSSQL Query
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .input(
        "FromDate",
        sql.Date,
        dates.CurrentFromDate
      )
      .input(
        "ToDate",
        sql.Date,
        dates.CurrentToDate
      )
      .query(`
        -- ====================================================
        -- PREVIOUS PERIOD
        -- ====================================================

        DECLARE @Days INT =
          DATEDIFF(DAY, @FromDate, @ToDate) + 1;

        DECLARE @PreviousFromDate DATE =
          DATEADD(DAY, -@Days, @FromDate);

        DECLARE @PreviousToDate DATE =
          DATEADD(DAY, -1, @FromDate);

        -- ====================================================
        -- CURRENT AND PREVIOUS PERIOD
        -- ====================================================

        ;WITH Periods AS
        (
          SELECT
            'Current' AS PeriodName,
            @FromDate AS FromDate,
            @ToDate AS ToDate

          UNION ALL

          SELECT
            'Previous',
            @PreviousFromDate,
            @PreviousToDate
        ),

        -- ====================================================
        -- ACTIVE NILE HOTELS
        -- ====================================================

        ActiveHotels AS
        (
          SELECT DISTINCT
            OrganizationID

          FROM dbo.htl_tbl_organization_master

          WHERE Activation_status = 1
            AND IsNileHotel = 1
        ),

        -- ====================================================
        -- REPORT MASTER DATA
        -- ====================================================

        ReportData AS
        (
          SELECT
            p.PeriodName,
            m.EntryID,
            m.OrganizationID

          FROM Periods p

          INNER JOIN
            DailyRevenueReport.DailyRevenueReport_Tbl_Report_Entry_Master m
              ON m.EntryDate >= p.FromDate
             AND m.EntryDate < DATEADD(DAY, 1, p.ToDate)

          WHERE m.IsDeleted = 0

            AND (
              @OrganizationID IS NULL
              OR m.OrganizationID = @OrganizationID
            )
        ),

        -- ====================================================
        -- ADR / REVPAR - HOTEL WISE
        -- ====================================================

        RoomHotelData AS
        (
          SELECT
            m.PeriodName,
            m.OrganizationID,

            AVG(
              CASE
                WHEN r.ItemID = 16
                THEN TRY_CONVERT(
                  DECIMAL(18, 2),
                  NULLIF(
                    REPLACE(r.FTD_Actual, ',', ''),
                    ''
                  )
                )
              END
            ) AS ADR,

            AVG(
              CASE
                WHEN r.ItemID = 17
                THEN TRY_CONVERT(
                  DECIMAL(18, 2),
                  NULLIF(
                    REPLACE(r.FTD_Actual, ',', ''),
                    ''
                  )
                )
              END
            ) AS RevPAR

          FROM ReportData m

          INNER JOIN
            DailyRevenueReport.DailyRevenueReport_Tbl_Report_Room_Entry r
              ON m.EntryID = r.EntryID

          WHERE r.ItemID IN (16, 17)

          GROUP BY
            m.PeriodName,
            m.OrganizationID
        ),

        -- ====================================================
        -- ADR / REVPAR - COMBINED TOTAL
        -- ====================================================

        RoomTotals AS
        (
          SELECT
            PeriodName,
            AVG(ADR) AS ADR,
            AVG(RevPAR) AS RevPAR

          FROM RoomHotelData

          GROUP BY PeriodName
        ),

        -- ====================================================
        -- OUTLET / BANQUET REVENUE
        -- ====================================================

        RevenueTotals AS
        (
          SELECT
            m.PeriodName,

            -- OUTLET REVENUE
            SUM(
              CASE
                WHEN UPPER(LTRIM(RTRIM(o.ItemType))) = 'OUTLET'
                 AND UPPER(LTRIM(RTRIM(o.Item))) = 'TOTAL'

                THEN ISNULL(
                  TRY_CONVERT(
                    DECIMAL(18, 2),
                    NULLIF(
                      REPLACE(o.FTD_Actual, ',', ''),
                      ''
                    )
                  ),
                  0
                )

                ELSE 0
              END
            ) AS OutletRevenue,

            -- BANQUET REVENUE
            SUM(
              CASE
                WHEN UPPER(LTRIM(RTRIM(o.ItemType))) = 'BANQUET'
                 AND UPPER(LTRIM(RTRIM(o.Item))) = 'TOTAL'
                 AND h.OrganizationID IS NOT NULL

                THEN ISNULL(
                  TRY_CONVERT(
                    DECIMAL(18, 2),
                    NULLIF(
                      REPLACE(o.FTD_Actual, ',', ''),
                      ''
                    )
                  ),
                  0
                )

                ELSE 0
              END
            ) AS BanquetRevenue

          FROM ReportData m

          INNER JOIN
            DailyRevenueReport.DailyRevenueReport_Tbl_Report_Outlet_Entry o
              ON m.EntryID = o.EntryID

          LEFT JOIN ActiveHotels h
            ON m.OrganizationID = h.OrganizationID

          WHERE UPPER(LTRIM(RTRIM(o.Item))) = 'TOTAL'

          GROUP BY m.PeriodName
        ),

        -- ====================================================
        -- CURRENT AND PREVIOUS METRIC VALUES
        -- ====================================================

        MetricData AS
        (
          SELECT
            p.PeriodName,

            CAST(
              ISNULL(r.ADR, 0)
              AS DECIMAL(18, 2)
            ) AS ADR,

            CAST(
              ISNULL(r.RevPAR, 0)
              AS DECIMAL(18, 2)
            ) AS RevPAR,

            CAST(
              ISNULL(v.OutletRevenue, 0)
              AS DECIMAL(18, 2)
            ) AS OutletRevenue,

            CAST(
              ISNULL(v.BanquetRevenue, 0)
              AS DECIMAL(18, 2)
            ) AS BanquetRevenue

          FROM Periods p

          LEFT JOIN RoomTotals r
            ON p.PeriodName = r.PeriodName

          LEFT JOIN RevenueTotals v
            ON p.PeriodName = v.PeriodName
        ),

        -- ====================================================
        -- CURRENT VS PREVIOUS
        -- ====================================================

        MetricComparison AS
        (
          SELECT
            1 AS SortOrder,
            'ADR' AS Metric,
            c.ADR AS Amount,
            p.ADR AS PreviousAmount

          FROM MetricData c
          CROSS JOIN MetricData p

          WHERE c.PeriodName = 'Current'
            AND p.PeriodName = 'Previous'

          UNION ALL

          SELECT
            2,
            'RevPAR',
            c.RevPAR,
            p.RevPAR

          FROM MetricData c
          CROSS JOIN MetricData p

          WHERE c.PeriodName = 'Current'
            AND p.PeriodName = 'Previous'

          UNION ALL

          SELECT
            3,
            'Outlet Revenue',
            c.OutletRevenue,
            p.OutletRevenue

          FROM MetricData c
          CROSS JOIN MetricData p

          WHERE c.PeriodName = 'Current'
            AND p.PeriodName = 'Previous'

          UNION ALL

          SELECT
            4,
            'Banquet Revenue',
            c.BanquetRevenue,
            p.BanquetRevenue

          FROM MetricData c
          CROSS JOIN MetricData p

          WHERE c.PeriodName = 'Current'
            AND p.PeriodName = 'Previous'
        )

        -- ====================================================
        -- FINAL RESULT
        -- ====================================================

        SELECT
          Metric,

          Amount,

          PreviousAmount,

          CAST(
            Amount - PreviousAmount
            AS DECIMAL(18, 2)
          ) AS Difference,

          CAST(
            CASE
              WHEN PreviousAmount = 0 THEN 0

              ELSE
                (Amount - PreviousAmount)
                * 100.0
                / PreviousAmount
            END
            AS DECIMAL(18, 2)
          ) AS GrowthPercentage,

          CASE
            WHEN Amount > PreviousAmount THEN 'UP'
            WHEN Amount < PreviousAmount THEN 'DOWN'
            ELSE 'SAME'
          END AS Trend

        FROM MetricComparison

        ORDER BY SortOrder;
      `);

    // ========================================================
    // 6. Previous Period Date Calculation
    // ========================================================

    const fromDate = new Date(
      `${dates.CurrentFromDate}T00:00:00.000Z`
    );

    const toDate = new Date(
      `${dates.CurrentToDate}T00:00:00.000Z`
    );

    const days = Math.round(
      (toDate.getTime() - fromDate.getTime()) /
        86400000
    ) + 1;

    const previousFrom = new Date(fromDate);
    previousFrom.setUTCDate(
      previousFrom.getUTCDate() - days
    );

    const previousTo = new Date(fromDate);
    previousTo.setUTCDate(
      previousTo.getUTCDate() - 1
    );

    // ========================================================
    // 7. Response Mapping
    // ========================================================

    const metrics = result.recordset.map((row) => ({
      Metric: row.Metric,

      Amount: Number(row.Amount ?? 0),

      PreviousAmount: Number(
        row.PreviousAmount ?? 0
      ),

      Difference: Number(row.Difference ?? 0),

      GrowthPercentage: Number(
        row.GrowthPercentage ?? 0
      ),

      Trend: row.Trend ?? "SAME",
    }));

    // ========================================================
    // 8. Response
    // ========================================================

    return ok(
      "CEO revenue performance fetched successfully.",
      metrics,
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        CurrentPeriod: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        PreviousPeriod: {
          FromDate:
            previousFrom.toISOString().slice(0, 10),

          ToDate:
            previousTo.toISOString().slice(0, 10),
        },

        TotalMetrics: metrics.length,
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO revenue performance"
    );
  }
};
// 1.2============================================================CEO Revenue Summary Adr/Revpar Details
const getCEOADRRevPARDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;
    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 5. MSSQL Query - ADR / RevPAR
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .input("FromDate", sql.Date, dates.CurrentFromDate)
      .input("ToDate", sql.Date, dates.CurrentToDate)
      .query(`
        ;WITH HotelData AS
        (
          SELECT
            m.OrganizationID,

            dbo.FN_Get_OrganizationShortName(
              m.OrganizationID
            ) AS Hotel,

            CAST(
              AVG(
                CASE
                  WHEN r.ItemID = 16
                  THEN TRY_CONVERT(
                    DECIMAL(18, 2),
                    NULLIF(
                      REPLACE(r.FTD_Actual, ',', ''),
                      ''
                    )
                  )
                END
              ) AS DECIMAL(18, 2)
            ) AS ADR,

            CAST(
              AVG(
                CASE
                  WHEN r.ItemID = 17
                  THEN TRY_CONVERT(
                    DECIMAL(18, 2),
                    NULLIF(
                      REPLACE(r.FTD_Actual, ',', ''),
                      ''
                    )
                  )
                END
              ) AS DECIMAL(18, 2)
            ) AS RevPAR

          FROM DailyRevenueReport.DailyRevenueReport_Tbl_Report_Entry_Master AS m

          INNER JOIN DailyRevenueReport.DailyRevenueReport_Tbl_Report_Room_Entry AS r
            ON m.EntryID = r.EntryID

          WHERE m.IsDeleted = 0

            AND (
              @OrganizationID IS NULL
              OR m.OrganizationID = @OrganizationID
            )

            AND m.EntryDate >= @FromDate
            AND m.EntryDate < DATEADD(DAY, 1, @ToDate)

            AND r.ItemID IN (16, 17)

          GROUP BY m.OrganizationID
        ),

        FinalResult AS
        (
          SELECT
            0 AS SortOrder,
            OrganizationID,
            Hotel,
            ADR,
            RevPAR
          FROM HotelData

          UNION ALL

          SELECT
            1 AS SortOrder,
            NULL AS OrganizationID,
            'TOTAL' AS Hotel,

            CAST(
              AVG(ADR) AS DECIMAL(18, 2)
            ) AS ADR,

            CAST(
              AVG(RevPAR) AS DECIMAL(18, 2)
            ) AS RevPAR

          FROM HotelData
        )

        SELECT
          OrganizationID,
          Hotel,
          ADR,
          RevPAR

        FROM FinalResult

        ORDER BY SortOrder, Hotel;
      `);

    // ========================================================
    // 6. Response Mapping
    // ========================================================

    const rows = result.recordset || [];

    const hotelDetails = rows
      .filter((row) => row.Hotel !== "TOTAL")
      .map((row, index) => ({
        SrNo: index + 1,

        OrganizationID: row.OrganizationID == null
          ? null
          : String(row.OrganizationID),

        Hotel: row.Hotel ?? null,

        ADR: row.ADR == null ? null : Number(row.ADR),

        RevPAR: row.RevPAR == null
          ? null
          : Number(row.RevPAR),
      }));

    const totalRow = rows.find(
      (row) => row.Hotel === "TOTAL"
    );

    const grandTotal = {
      Hotel: "TOTAL",

      ADR: totalRow?.ADR == null
        ? null
        : Number(totalRow.ADR),

      RevPAR: totalRow?.RevPAR == null
        ? null
        : Number(totalRow.RevPAR),
    };

    // ========================================================
    // 7. Response
    // ========================================================

    return ok(
      "CEO ADR and RevPAR details fetched successfully.",
      {
        ADRRevPARDetails: hotelDetails,
        GrandTotal: grandTotal,
      },
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalOrganizations: hotelDetails.length,
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO ADR RevPAR details"
    );
  }
};
// 1.3============================================================CEO Revenue Summary Oulet Details
const getCEOOutletRevenueDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;
    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 5. MSSQL Query - OUTLET REVENUE
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .input("FromDate", sql.Date, dates.CurrentFromDate)
      .input("ToDate", sql.Date, dates.CurrentToDate)
      .query(`
        ;WITH HotelData AS
        (
          SELECT
            m.OrganizationID,

            dbo.FN_Get_OrganizationShortName(
              m.OrganizationID
            ) AS Hotel,

            SUM(
              ISNULL(
                TRY_CONVERT(
                  DECIMAL(18, 2),
                  NULLIF(
                    REPLACE(o.FTD_Actual, ',', ''),
                    ''
                  )
                ),
                0
              )
            ) AS OutletRevenue

          FROM DailyRevenueReport.DailyRevenueReport_Tbl_Report_Entry_Master AS m

          INNER JOIN DailyRevenueReport.DailyRevenueReport_Tbl_Report_Outlet_Entry AS o
            ON m.EntryID = o.EntryID

          WHERE m.IsDeleted = 0

            AND (
              @OrganizationID IS NULL
              OR m.OrganizationID = @OrganizationID
            )

            AND m.EntryDate >= @FromDate
            AND m.EntryDate < DATEADD(DAY, 1, @ToDate)

            AND LTRIM(RTRIM(o.Item)) = 'Total'
            AND LTRIM(RTRIM(o.ItemType)) = 'Outlet'

          GROUP BY m.OrganizationID
        )

        SELECT
          OrganizationID,
          Hotel,
          OutletRevenue

        FROM
        (
          SELECT
            0 AS SortOrder,
            OrganizationID,
            Hotel,
            OutletRevenue
          FROM HotelData

          UNION ALL

          SELECT
            1 AS SortOrder,
            CAST(NULL AS BIGINT) AS OrganizationID,
            'TOTAL' AS Hotel,

            ISNULL(
              SUM(OutletRevenue),
              0
            ) AS OutletRevenue

          FROM HotelData
        ) AS FinalResult

        ORDER BY SortOrder, Hotel;
      `);

    // ========================================================
    // 6. Response Mapping
    // ========================================================

    const rows = result.recordset || [];

    const hotelDetails = rows
      .filter((row) => row.Hotel !== "TOTAL")
      .map((row, index) => ({
        SrNo: index + 1,

        OrganizationID: row.OrganizationID == null
          ? null
          : String(row.OrganizationID),

        Hotel: row.Hotel ?? null,

        OutletRevenue: Number(row.OutletRevenue ?? 0),
      }));

    const totalRow = rows.find(
      (row) => row.Hotel === "TOTAL"
    );

    const grandTotal = {
      Hotel: "TOTAL",

      OutletRevenue: Number(
        totalRow?.OutletRevenue ?? 0
      ),
    };

    // ========================================================
    // 7. Response
    // ========================================================

    return ok(
      "CEO outlet revenue details fetched successfully.",
      {
        OutletRevenueDetails: hotelDetails,
        GrandTotal: grandTotal,
      },
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalOrganizations: hotelDetails.length,
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO outlet revenue details"
    );
  }
};
// 1.4============================================================CEO Revenue Summary banquet Details
const getCEOBanquetRevenueDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;
    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 5. MSSQL Query - BANQUET REVENUE
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .input("FromDate", sql.Date, dates.CurrentFromDate)
      .input("ToDate", sql.Date, dates.CurrentToDate)
      .query(`
        ;WITH Hotels AS
        (
          SELECT
            h.OrganizationID,

            dbo.FN_Get_OrganizationShortName(
              h.OrganizationID
            ) AS Hotel

          FROM dbo.htl_tbl_organization_master h

          WHERE h.Activation_status = 1
            AND h.IsNileHotel = 1

            AND (
              @OrganizationID IS NULL
              OR h.OrganizationID = @OrganizationID
            )
        ),

        -- ====================================================
        -- BANQUET REVENUE
        -- ====================================================

        BanquetData AS
        (
          SELECT
            m.OrganizationID,

            SUM(
              ISNULL(
                TRY_CONVERT(
                  DECIMAL(18, 2),
                  NULLIF(
                    REPLACE(o.FTD_Actual, ',', ''),
                    ''
                  )
                ),
                0
              )
            ) AS BanquetRevenue

          FROM DailyRevenueReport.DailyRevenueReport_Tbl_Report_Entry_Master m

          INNER JOIN DailyRevenueReport.DailyRevenueReport_Tbl_Report_Outlet_Entry o
            ON m.EntryID = o.EntryID

          WHERE m.IsDeleted = 0

            AND (
              @OrganizationID IS NULL
              OR m.OrganizationID = @OrganizationID
            )

            AND m.EntryDate >= @FromDate
            AND m.EntryDate < DATEADD(DAY, 1, @ToDate)

            AND UPPER(LTRIM(RTRIM(o.ItemType))) = 'BANQUET'
            AND UPPER(LTRIM(RTRIM(o.Item))) = 'TOTAL'

          GROUP BY m.OrganizationID
        ),

        -- ====================================================
        -- HOTEL-WISE DATA
        -- ====================================================

        HotelData AS
        (
          SELECT
            h.OrganizationID,
            h.Hotel,

            ISNULL(
              b.BanquetRevenue,
              0
            ) AS BanquetRevenue

          FROM Hotels h

          LEFT JOIN BanquetData b
            ON h.OrganizationID = b.OrganizationID
        )

        -- ====================================================
        -- FINAL RESULT + TOTAL ROW
        -- ====================================================

        SELECT
          OrganizationID,
          Hotel,
          BanquetRevenue

        FROM
        (
          SELECT
            0 AS SortOrder,
            OrganizationID,
            Hotel,
            BanquetRevenue
          FROM HotelData

          UNION ALL

          SELECT
            1 AS SortOrder,
            CAST(NULL AS BIGINT) AS OrganizationID,
            'TOTAL' AS Hotel,

            ISNULL(
              SUM(BanquetRevenue),
              0
            ) AS BanquetRevenue

          FROM HotelData

        ) AS FinalResult

        ORDER BY SortOrder, Hotel;
      `);

    // ========================================================
    // 6. Response Mapping
    // ========================================================

    const rows = result.recordset || [];

    const hotelDetails = rows
      .filter((row) => row.Hotel !== "TOTAL")
      .map((row, index) => ({
        SrNo: index + 1,

        OrganizationID: row.OrganizationID == null
          ? null
          : String(row.OrganizationID),

        Hotel: row.Hotel ?? null,

        BanquetRevenue: Number(
          row.BanquetRevenue ?? 0
        ),
      }));

    const totalRow = rows.find(
      (row) => row.Hotel === "TOTAL"
    );

    const grandTotal = {
      Hotel: "TOTAL",

      BanquetRevenue: Number(
        totalRow?.BanquetRevenue ?? 0
      ),
    };

    // ========================================================
    // 7. Response
    // ========================================================

    return ok(
      "CEO banquet revenue details fetched successfully.",
      {
        BanquetRevenueDetails: hotelDetails,
        GrandTotal: grandTotal,
      },
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalOrganizations: hotelDetails.length,
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO banquet revenue details"
    );
  }
};
// 1.5============================================================CEO Revenue Summary Total Revenew Details
const getCEOTotalRevenueDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 5. MSSQL Query - TOTAL REVENUE
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .input(
        "FromDate",
        sql.Date,
        dates.CurrentFromDate
      )
      .input(
        "ToDate",
        sql.Date,
        dates.CurrentToDate
      )
      .query(`
        ;WITH HotelData AS
        (
          SELECT
            a.OrganizationID,

            dbo.FN_Get_OrganizationShortName(
              a.OrganizationID
            ) AS Hotel,

            SUM(
              ISNULL(a.FTD_Total_Revenue, 0)
            ) AS TotalRevenue

          FROM DailyRevenueReport.DailyRevenueReport_Tbl_Entry_Master a

          WHERE a.IsDeleted = 0

            AND (
              @OrganizationID IS NULL
              OR a.OrganizationID = @OrganizationID
            )

            AND a.EntryDate >= @FromDate
            AND a.EntryDate < DATEADD(DAY, 1, @ToDate)

          GROUP BY a.OrganizationID
        )

        SELECT
          OrganizationID,
          Hotel,
          TotalRevenue

        FROM
        (
          SELECT
            0 AS SortOrder,
            OrganizationID,
            Hotel,
            TotalRevenue
          FROM HotelData

          UNION ALL

          SELECT
            1 AS SortOrder,
            CAST(NULL AS BIGINT) AS OrganizationID,
            'TOTAL' AS Hotel,

            ISNULL(
              SUM(TotalRevenue),
              0
            ) AS TotalRevenue

          FROM HotelData
        ) x

        ORDER BY SortOrder, Hotel;
      `);

    // ========================================================
    // 6. Response Mapping
    // ========================================================

    const rows = result.recordset || [];

    const revenueDetails = rows
      .filter((row) => row.OrganizationID != null)
      .map((row, index) => ({
        SrNo: index + 1,

        OrganizationID: String(row.OrganizationID),

        Hotel: row.Hotel ?? null,

        TotalRevenue: Number(row.TotalRevenue ?? 0),
      }));

    const totalRow = rows.find(
      (row) => row.OrganizationID == null
    );

    const grandTotal = {
      Hotel: "TOTAL",
      TotalRevenue: Number(totalRow?.TotalRevenue ?? 0),
    };

    // ========================================================
    // 7. Response
    // ========================================================

    return ok(
      "CEO total revenue details fetched successfully.",
      {
        TotalRevenueDetails: revenueDetails,
        GrandTotal: grandTotal,
      },
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalOrganizations: revenueDetails.length,
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO total revenue details"
    );
  }
};
// 1.6============================================================CEO Revenue Summary Room Revenew Details
const getCEORoomsRevenueDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 5. MSSQL Query - ROOMS REVENUE
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .input(
        "FromDate",
        sql.Date,
        dates.CurrentFromDate
      )
      .input(
        "ToDate",
        sql.Date,
        dates.CurrentToDate
      )
      .query(`
        ;WITH HotelData AS
        (
          SELECT
            a.OrganizationID,

            dbo.FN_Get_OrganizationShortName(
              a.OrganizationID
            ) AS Hotel,

            SUM(
              ISNULL(a.FTD_Room_Revenue, 0)
            ) AS RoomsRevenue

          FROM DailyRevenueReport.DailyRevenueReport_Tbl_Entry_Master a

          WHERE a.IsDeleted = 0

            AND (
              @OrganizationID IS NULL
              OR a.OrganizationID = @OrganizationID
            )

            AND a.EntryDate >= @FromDate
            AND a.EntryDate < DATEADD(DAY, 1, @ToDate)

          GROUP BY a.OrganizationID
        )

        SELECT
          OrganizationID,
          Hotel,
          RoomsRevenue

        FROM
        (
          SELECT
            0 AS SortOrder,
            OrganizationID,
            Hotel,
            RoomsRevenue
          FROM HotelData

          UNION ALL

          SELECT
            1 AS SortOrder,
            CAST(NULL AS BIGINT) AS OrganizationID,
            'TOTAL' AS Hotel,

            ISNULL(
              SUM(RoomsRevenue),
              0
            ) AS RoomsRevenue

          FROM HotelData
        ) x

        ORDER BY SortOrder, Hotel;
      `);

    // ========================================================
    // 6. Response Mapping
    // ========================================================

    const rows = result.recordset || [];

    const revenueDetails = rows
      .filter((row) => row.OrganizationID != null)
      .map((row, index) => ({
        SrNo: index + 1,

        OrganizationID: String(row.OrganizationID),

        Hotel: row.Hotel ?? null,

        RoomsRevenue: Number(row.RoomsRevenue ?? 0),
      }));

    const totalRow = rows.find(
      (row) => row.OrganizationID == null
    );

    const grandTotal = {
      Hotel: "TOTAL",
      RoomsRevenue: Number(totalRow?.RoomsRevenue ?? 0),
    };

    // ========================================================
    // 7. Response
    // ========================================================

    return ok(
      "CEO rooms revenue details fetched successfully.",
      {
        RoomsRevenueDetails: revenueDetails,
        GrandTotal: grandTotal,
      },
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalOrganizations: revenueDetails.length,
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO rooms revenue details"
    );
  }
};
// 1.7============================================================CEO Revenue Summary F&B Revenew Details
const getCEOFBRevenueDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 5. MSSQL Query - F&B REVENUE
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .input(
        "FromDate",
        sql.Date,
        dates.CurrentFromDate
      )
      .input(
        "ToDate",
        sql.Date,
        dates.CurrentToDate
      )
      .query(`
        ;WITH HotelData AS
        (
          SELECT
            a.OrganizationID,

            dbo.FN_Get_OrganizationShortName(
              a.OrganizationID
            ) AS Hotel,

            SUM(
              ISNULL(a.FTD_FB_Revenue, 0)
            ) AS FBRevenue

          FROM DailyRevenueReport.DailyRevenueReport_Tbl_Entry_Master a

          WHERE a.IsDeleted = 0

            AND (
              @OrganizationID IS NULL
              OR a.OrganizationID = @OrganizationID
            )

            AND a.EntryDate >= @FromDate
            AND a.EntryDate < DATEADD(DAY, 1, @ToDate)

          GROUP BY a.OrganizationID
        )

        SELECT
          OrganizationID,
          Hotel,
          FBRevenue

        FROM
        (
          SELECT
            0 AS SortOrder,
            OrganizationID,
            Hotel,
            FBRevenue
          FROM HotelData

          UNION ALL

          SELECT
            1 AS SortOrder,
            CAST(NULL AS BIGINT) AS OrganizationID,
            'TOTAL' AS Hotel,

            ISNULL(
              SUM(FBRevenue),
              0
            ) AS FBRevenue

          FROM HotelData
        ) x

        ORDER BY SortOrder, Hotel;
      `);

    // ========================================================
    // 6. Response Mapping
    // ========================================================

    const rows = result.recordset || [];

    const revenueDetails = rows
      .filter((row) => row.OrganizationID != null)
      .map((row, index) => ({
        SrNo: index + 1,

        OrganizationID: String(row.OrganizationID),

        Hotel: row.Hotel ?? null,

        FBRevenue: Number(row.FBRevenue ?? 0),
      }));

    const totalRow = rows.find(
      (row) => row.OrganizationID == null
    );

    const grandTotal = {
      Hotel: "TOTAL",
      FBRevenue: Number(totalRow?.FBRevenue ?? 0),
    };

    // ========================================================
    // 7. Response
    // ========================================================

    return ok(
      "CEO F&B revenue details fetched successfully.",
      {
        FBRevenueDetails: revenueDetails,
        GrandTotal: grandTotal,
      },
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalOrganizations: revenueDetails.length,
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO F&B revenue details"
    );
  }
};
// 2. ============================================================ Get CEO Occupancy
const getCEOOccupancy = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range (Existing Helper)
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 5. MSSQL Query - HOTEL WISE OCCUPANCY
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .input(
        "FromDate",
        sql.Date,
        dates.CurrentFromDate
      )
      .input(
        "ToDate",
        sql.Date,
        dates.CurrentToDate
      )
      .query(`
        ;WITH Hotels AS
        (
          SELECT
            org.OrganizationID,
            org.ShortDisplayLabel AS Hotel

          FROM dbo.htl_tbl_organization_master AS org

          WHERE org.Activation_status = 1
            AND org.IsNileHotel = 1

            AND (
              @OrganizationID IS NULL
              OR org.OrganizationID = @OrganizationID
            )
        ),

        -- ====================================================
        -- ROOMS OCCUPIED AND ROOMS AVAILABLE
        -- ====================================================

        RoomData AS
        (
          SELECT
            a.OrganizationID,

            SUM(
              CASE
                WHEN i.Item = 'Rooms Occupied'
                THEN ISNULL(b.Amount, 0)
                ELSE 0
              END
            ) AS RoomsOccupied,

            SUM(
              CASE
                WHEN i.Item = 'Rooms Available'
                THEN ISNULL(b.Amount, 0)
                ELSE 0
              END
            ) AS RoomsAvailable

          FROM DailyRevenueReport.DailyRevenueReport_Tbl_Entry_Master AS a

          INNER JOIN DailyRevenueReport.DailyRevenueReport_Tbl_Entry_Room_Details AS b
            ON a.ID = b.EntryID

          INNER JOIN DailyRevenueReport.DailyRevenueReport_Tbl_Room_Item_Master AS i
            ON b.ItemID = i.ItemID

          WHERE a.IsDeleted = 0
            AND b.IsDelete = 0

            AND a.EntryDate >= @FromDate
            AND a.EntryDate < DATEADD(DAY, 1, @ToDate)

            AND i.Item IN (
              'Rooms Occupied',
              'Rooms Available'
            )

          GROUP BY a.OrganizationID
        )

        -- ====================================================
        -- FINAL HOTEL-WISE OCCUPANCY
        -- ====================================================

        SELECT
          h.OrganizationID,
          h.Hotel,

          CAST(
            CASE
              WHEN ISNULL(r.RoomsAvailable, 0) > 0
              THEN
                (r.RoomsOccupied * 100.0)
                / r.RoomsAvailable
              ELSE 0
            END
            AS DECIMAL(12, 2)
          ) AS OCC

        FROM Hotels AS h

        LEFT JOIN RoomData AS r
          ON h.OrganizationID = r.OrganizationID

        ORDER BY h.Hotel;
      `);

    // ========================================================
    // 6. Response Mapping
    // ========================================================

    const occupancyData = result.recordset.map((row) => ({
      OrganizationID: Number(row.OrganizationID),

      ShortName: row.Hotel ?? null,

      Occupancy: Number(row.OCC ?? 0),
      occupancypercentage: `${Math.round(Number(row.OCC ?? 0))}%`,
    }));

    // ========================================================
    // 7. Response
    // ========================================================

    return ok(
      "CEO occupancy fetched successfully.",
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalOrganizations: occupancyData.length,

        OccupancyData: occupancyData,
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO occupancy"
    );
  }
};
// 3. ============================================================ Critical Alerts
// 3.1. ============================================Glitch
const getCEOGlitchAlerts = async (data) => {
  try {
    const rawOrganizationID = data.OrganizationID;
    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      ((typeof rawOrganizationID !== "string" && typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n)
    ) {
      return fail("OrganizationID must be a positive integer.", 400);
    }

    // ========================================================

    // ========================================================
    // 2. Total Open Glitches
    // ========================================================

    const countResult = await pool.query(
      `
        SELECT COUNT(*)::BIGINT AS TotalCount
        FROM guest_glitch_entry_master
        WHERE IsDeleted = FALSE
          AND UPPER(TRIM(Status)) = 'OPEN'
          AND ($1::BIGINT IS NULL OR OrganizationID = $1::BIGINT);
      `,
      [organizationID || null]
    );

    const totalCount = Number(
      countResult.rows[0].totalcount
    );

    // ========================================================
    // 3. Latest Open Glitches
    // ========================================================

    const result = await pool.query(
      `
        SELECT
          glitch.ID,
          glitch.OrganizationID,
          organization.ShortName,
          glitch.GuestName,
          glitch.Complaint,
          glitch.EntryDate,
          glitch.Time,
          glitch.Status,
          glitch.RoomNumber,
          glitch.Department

        FROM guest_glitch_entry_master AS glitch
        LEFT JOIN Organization_Master AS organization
          ON organization.OrganizationID = glitch.OrganizationID

        WHERE glitch.IsDeleted = FALSE
          AND UPPER(TRIM(glitch.Status)) = 'OPEN'
          AND ($1::BIGINT IS NULL OR glitch.OrganizationID = $1::BIGINT)

        ORDER BY
          glitch.EntryDate DESC NULLS LAST,
          glitch.ID DESC
;
      `,
      [organizationID || null]
    );

    // ========================================================
    // 4. Response Mapping
    // ========================================================

    const glitches = result.rows.map((row) => ({
      ID: Number(row.id),

      OrganizationID:
        row.organizationid == null
          ? null
          : Number(row.organizationid),

      ShortName: row.shortname ?? null,

      GuestName: row.guestname || null,
      Complaint: row.complaint || null,

      EntryDate: row.entrydate
        ? new Date(row.entrydate).toISOString().slice(0, 10)
        : null,

      Time: row.time || null,
      Status: row.status,

      RoomNumber: row.roomnumber || null,
      Department: row.department || null,

      Priority: "High",
    }));

    // ========================================================
    // 5. Response
    // ========================================================

    return ok(
      "CEO open glitch alerts fetched successfully.",
      glitches,
      {
        TotalCount: totalCount,
      }
    );

  } catch (error) {
    return databaseFailure(error, "Fetch CEO glitch alerts");
  }
};
// 3.2. ============================================Incident
const getCEOIncidentAlerts = async (data) => {
  try {
    const rawOrganizationID = data.OrganizationID;
    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      ((typeof rawOrganizationID !== "string" && typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n)
    ) {
      return fail("OrganizationID must be a positive integer.", 400);
    }

    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================

    // ========================================================
    // 3. Date Range (Existing Helper)
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. Total Incident Count
    // ========================================================

    const countResult = await pool.query(
      `
        SELECT
          COUNT(*)::BIGINT AS TotalCount

        FROM incident_report_entry_master

        WHERE IsDeleted = FALSE
          AND IncidentDate >= $1::DATE
          AND IncidentDate <= $2::DATE
          AND ($3::BIGINT IS NULL OR OrganizationID = $3::BIGINT);
      `,
      [
        dates.CurrentFromDate,
        dates.CurrentToDate,
        organizationID || null,
      ]
    );

    const totalCount = Number(
      countResult.rows[0].totalcount
    );

    // ========================================================
    // 5. Incident List
    // ========================================================

    const result = await pool.query(
      `
        SELECT
          incident.ID,
          incident.OrganizationID,
          organization.ShortName,
          incident.ReportDate,
          incident.IncidentDate,
          incident.Time,
          incident.Location,
          incident.AccidentCause,
          incident.AnyCasualty,
          incident.Description,
          incident.DamagedCaused,
          incident.Investigation,
          incident.InvestigatedBy,
          incident.PresentDuringIncident,
          incident.ReportTo,
          incident.ReportBy

        FROM incident_report_entry_master AS incident
        LEFT JOIN Organization_Master AS organization
          ON organization.OrganizationID = incident.OrganizationID

        WHERE incident.IsDeleted = FALSE
          AND incident.IncidentDate >= $1::DATE
          AND incident.IncidentDate <= $2::DATE
          AND ($3::BIGINT IS NULL OR incident.OrganizationID = $3::BIGINT)

        ORDER BY
          incident.IncidentDate DESC,
          incident.Time DESC NULLS LAST,
          incident.ID DESC
;
      `,
      [
        dates.CurrentFromDate,
        dates.CurrentToDate,
        organizationID || null,
      ]
    );

    // ========================================================
    // 6. Response Mapping
    // ========================================================

    const incidents = result.rows.map((row) => ({
      ID: row.id,

      OrganizationID: Number(row.organizationid),
      ShortName: row.shortname ?? null,

      ReportDate: row.reportdate
        ? row.reportdate.toISOString().slice(0, 10)
        : null,

      IncidentDate: row.incidentdate
        ? row.incidentdate.toISOString().slice(0, 10)
        : null,

      Time: row.time || null,
      Location: row.location || null,

      AccidentCause: row.accidentcause || null,
      AnyCasualty: row.anycasualty || null,

      Description: row.description || null,
      DamagedCaused: row.damagedcaused || null,

      Investigation: row.investigation || null,
      InvestigatedBy: row.investigatedby || null,

      PresentDuringIncident:
        row.presentduringincident || null,

      ReportTo: row.reportto || null,
      ReportBy: row.reportby || null,
    }));

    // ========================================================
    // 7. Response
    // ========================================================

    return ok(
      "CEO incident alerts fetched successfully.",
      incidents,
      {
        Filter: filter,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalCount: totalCount,
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO incident alerts"
    );
  }
};
// 3.3 ============================================Engineering Expired AMC
const getCEOExpiredAMCAlerts = async (data) => {
  try {
    const rawOrganizationID = data.OrganizationID;
    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      ((typeof rawOrganizationID !== "string" && typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n)
    ) {
      return fail("OrganizationID must be a positive integer.", 400);
    }

    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================

    // ========================================================
    // 3. Date Range (Existing Helper)
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. Total Expired AMC Count
    // ========================================================

    const countResult = await pool.query(
      `
        SELECT
          COUNT(*)::BIGINT AS TotalCount

        FROM Engineering_Equipment_Entry_Master

        WHERE IsDeleted = FALSE
          AND AMCEndDate IS NOT NULL
          AND AMCEndDate >= $1::DATE
          AND AMCEndDate <= $2::DATE
          AND AMCEndDate < CURRENT_DATE
          AND ($3::BIGINT IS NULL OR OrganizationID = $3::BIGINT);
      `,
      [
        dates.CurrentFromDate,
        dates.CurrentToDate,
        organizationID || null,
      ]
    );

    const totalCount = Number(
      countResult.rows[0].totalcount
    );

    // ========================================================
    // 5. Expired AMC List
    // ========================================================

    const result = await pool.query(
      `
        SELECT
          equipment.EquipmentID,
          equipment.OrganizationID,
          organization.ShortName,
          equipment.Description,
          equipment.SerialNumber,
          equipment.TypeOfMachine,
          equipment.Make,
          equipment.ModelNumber,
          equipment.Area,
          equipment.AMCType,
          equipment.AMCStartDate,
          equipment.AMCEndDate,
          equipment.AMCStatus,
          equipment.AMCYearlyExpense,
          equipment.IsMandatoryAMC

        FROM Engineering_Equipment_Entry_Master AS equipment
        LEFT JOIN Organization_Master AS organization
          ON organization.OrganizationID = equipment.OrganizationID

        WHERE equipment.IsDeleted = FALSE
          AND equipment.AMCEndDate IS NOT NULL
          AND equipment.AMCEndDate >= $1::DATE
          AND equipment.AMCEndDate <= $2::DATE
          AND equipment.AMCEndDate < CURRENT_DATE
          AND ($3::BIGINT IS NULL OR equipment.OrganizationID = $3::BIGINT)

        ORDER BY
          equipment.AMCEndDate DESC,
          equipment.EquipmentID DESC
;
      `,
      [
        dates.CurrentFromDate,
        dates.CurrentToDate,
        organizationID || null,
      ]
    );

    // ========================================================
    // 6. Response Mapping
    // ========================================================

    const amcAlerts = result.rows.map((row) => ({
      EquipmentID: Number(row.equipmentid),

      OrganizationID: Number(row.organizationid),
      ShortName: row.shortname ?? null,

      Description: row.description || null,
      SerialNumber: row.serialnumber || null,
      TypeOfMachine: row.typeofmachine || null,
      Make: row.make || null,
      ModelNumber: row.modelnumber || null,
      Area: row.area || null,

      AMCType: row.amctype || null,

      AMCStartDate: row.amcstartdate
        ? formatDate(row.amcstartdate)
        : null,

      AMCEndDate: row.amcenddate
        ? formatDate(row.amcenddate)
        : null,

      AMCStatus: "Expired",

      AMCYearlyExpense:
        row.amcyearlyexpense == null
          ? null
          : Number(row.amcyearlyexpense),

      IsMandatoryAMC: Boolean(row.ismandatoryamc),

      Priority: "High",
    }));

    // ========================================================
    // 7. Response
    // ========================================================

    return ok(
      "CEO expired AMC alerts fetched successfully.",
      amcAlerts,
      {
        Filter: filter,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalCount: totalCount,
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO expired AMC alerts"
    );
  }
};
// 4. ============================================================ Hotel Revenue vs Budget
const getCEOHotelRevenueVsBudget = async (data) => {
  try {
    const rawOrganizationID = data.OrganizationID;
    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      ((typeof rawOrganizationID !== "string" && typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n)
    ) {
      return fail("OrganizationID must be a positive integer.", 400);
    }

    // ========================================================
    // 1. Business Date
    // ========================================================

    let businessDate = data.BusinessDate;

    if (!businessDate) {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date());

      const values = {};

      parts.forEach(({ type, value }) => {
        if (type !== "literal") {
          values[type] = Number(value);
        }
      });

      const yesterday = new Date(
        Date.UTC(
          values.year,
          values.month - 1,
          values.day - 1
        )
      );

      businessDate = yesterday.toISOString().slice(0, 10);
    }

    // ========================================================
    // 2. Date Validation
    // ========================================================

    if (
      typeof businessDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)
    ) {
      return fail(
        "BusinessDate must be in YYYY-MM-DD format.",
        400
      );
    }

    const parsedDate = new Date(
      `${businessDate}T00:00:00.000Z`
    );

    if (
      Number.isNaN(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== businessDate
    ) {
      return fail("Invalid BusinessDate.", 400);
    }

    // ========================================================
    // 3. MSSQL Query
    // ========================================================

    const mssqlPool = await getMssqlPool();

    const result = await mssqlPool
      .request()
      .input("BusinessDate", sql.Date, businessDate)
      .input("OrganizationID", sql.BigInt, organizationID || null)
      .query(`
        WITH LatestRevenue AS (
          SELECT
            ID,
            OrganizationID,
            EntryDate,

            FTD_Budget,
            FTD_Total_Revenue,
            FTD_Variance,

            MTD_Budget,
            MTD_Revenue,
            MTD_Variance,

            YTD_Budget,
            YTD_Revenue,
            YTD_Variance,

            ROW_NUMBER() OVER (
              PARTITION BY OrganizationID
              ORDER BY ID DESC
            ) AS RowNo

          FROM
            [DailyRevenueReport].[DailyRevenueReport_Tbl_Entry_Master]

          WHERE IsDeleted = 0
            AND (@OrganizationID IS NULL OR OrganizationID = @OrganizationID)
            AND EntryDate >= @BusinessDate
            AND EntryDate < DATEADD(
              DAY, 1, @BusinessDate
            )
        )

        SELECT
          ID,
          LatestRevenue.OrganizationID,
          organization.ShortDisplayLabel AS OrganizationShortName,
          EntryDate,

          FTD_Budget,
          FTD_Total_Revenue,
          FTD_Variance,

          MTD_Budget,
          MTD_Revenue,
          MTD_Variance,

          YTD_Budget,
          YTD_Revenue,
          YTD_Variance

        FROM LatestRevenue
        LEFT JOIN [dbo].[htl_tbl_organization_master] AS organization
          ON organization.OrganizationID = LatestRevenue.OrganizationID

        WHERE RowNo = 1

        ORDER BY
          organization.ShortDisplayLabel ASC,
          LatestRevenue.OrganizationID ASC;
      `);

    // ========================================================
    // 4. Response Mapping
    // ========================================================

    const hotels = result.recordset.map((row, index) => ({
      SrNo: index + 1,

      OrganizationID: Number(row.OrganizationID),
      OrganizationShortName: row.OrganizationShortName ?? null,

      FTD: {
        Budget: Number(row.FTD_Budget ?? 0),
        Revenue: Number(row.FTD_Total_Revenue ?? 0),
        Variance: Number(row.FTD_Variance ?? 0),
      },

      MTD: {
        Budget: Number(row.MTD_Budget ?? 0),
        Revenue: Number(row.MTD_Revenue ?? 0),
        Variance: Number(row.MTD_Variance ?? 0),
      },

      YTD: {
        Budget: Number(row.YTD_Budget ?? 0),
        Revenue: Number(row.YTD_Revenue ?? 0),
        Variance: Number(row.YTD_Variance ?? 0),
      },
    }));

    // ========================================================
    // 5. Response
    // ========================================================

    return ok(
      "CEO hotel revenue vs budget fetched successfully.",
      hotels,
      {
        BusinessDate: businessDate,
        TotalHotels: hotels.length,
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO hotel revenue vs budget"
    );
  }
};
// 5. ============================================================ DSR Trend
const getCEODSRChart = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID =
      rawOrganizationID == null
        ? ""
        : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range (Existing Helper)
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. MSSQL Query
    // ========================================================

    const mssqlPool = await getMssqlPool();

    const result = await mssqlPool
      .request()
      .input(
        "FromDate",
        sql.Date,
        dates.CurrentFromDate
      )
      .input(
        "ToDate",
        sql.Date,
        dates.CurrentToDate
      )
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .query(`
        SELECT
          organization.OrganizationID,
          organization.ShortDisplayLabel AS OrganizationShortName,
          COUNT(visit.OrganizationID) AS TotalVisit

        FROM [dbo].[htl_tbl_organization_master] AS organization
        LEFT JOIN [DailySalesReport].[DailySalesReport_Tbl_Account_Visit] AS visit
          ON visit.OrganizationID = organization.OrganizationID
          AND visit.CreatedDatetime >= @FromDate
          AND visit.CreatedDatetime < DATEADD(
            DAY, 1, @ToDate
          )

        WHERE (
            @OrganizationID IS NULL
            OR organization.OrganizationID = @OrganizationID
          )

        GROUP BY organization.OrganizationID, organization.ShortDisplayLabel

        ORDER BY organization.ShortDisplayLabel ASC, organization.OrganizationID ASC;
      `);

    // ========================================================
    // 5. Response Mapping
    // ========================================================

    const chartData = result.recordset.map((row) => ({
      OrganizationID: Number(row.OrganizationID),
      OrganizationShortName: row.OrganizationShortName ?? null,
      TotalVisit: Number(row.TotalVisit),
    }));

    // ========================================================
    // 6. Response
    // ========================================================

    return ok(
      "CEO DSR chart fetched successfully.",
      chartData,
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalOrganizations: chartData.length,

        TotalVisits: chartData.reduce(
          (sum, row) => sum + row.TotalVisit,
          0
        ),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO DSR chart"
    );
  }
};
// 5.1. ============================================================ DSR Details
const getCEODSRVisitDetails = async (data) => {
  try {
    // ========================================================
    // 1. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      !/^[1-9]\d*$/.test(organizationID) ||
      BigInt(organizationID) > 9223372036854775807n
    ) {
      return fail(
        "Valid OrganizationID is required.",
        400
      );
    }

    // ========================================================
    // 2. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 3. Pagination Validation
    // ========================================================

    const page = Number(data.page ?? 1);
    const pageSize = Number(data.PageSize ?? 10);

    if (
      !Number.isSafeInteger(page) ||
      page <= 0
    ) {
      return fail("Invalid page number.", 400);
    }

    if (
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      return fail(
        "PageSize must be between 1 and 100.",
        400
      );
    }

    const offset = (page - 1) * pageSize;

    if (!Number.isSafeInteger(offset)) {
      return fail("Pagination offset is too large.", 400);
    }

    // ========================================================
    // 4. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 5. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 6. MSSQL Query
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID
      )
      .input(
        "FromDate",
        sql.Date,
        dates.CurrentFromDate
      )
      .input(
        "ToDate",
        sql.Date,
        dates.CurrentToDate
      )
      .input("PageSize", sql.Int, pageSize)
      .input("Offset", sql.Int, offset)
      .query(`
        -- ================================================
        -- Total Visit Count
        -- ================================================

        SELECT
          COUNT(*) AS TotalCount

        FROM DailySalesReport.DailySalesReport_Tbl_Account_Visit AS v

        WHERE v.OrganizationID = @OrganizationID
          AND v.CreatedDate >= @FromDate
          AND v.CreatedDate < DATEADD(
            DAY, 1, @ToDate
          );

        -- ================================================
        -- DSR Visit Details
        -- ================================================

        SELECT
          v.ID AS VisitID,
          v.OrganizationID,

          dbo.FN_Get_OrganizationShortName(
            v.OrganizationID
          ) AS Hotel,

          v.AccountID,
          v.ContactID,

          am.CompanyName,

          LTRIM(RTRIM(
            ISNULL(cm.FirstName, '') + ' ' +
            ISNULL(cm.LastName, '')
          )) AS ContactName,

          CONVERT(
            VARCHAR(10),
            v.VisitDate,
            23
          ) AS VisitDate,

          v.CommunicationMode,

          CONVERT(
            VARCHAR(10),
            v.NextFollowUpDate,
            23
          ) AS NextFollowUpDate,

          v.Remarks,
          v.Username,
          v.GuestResponse,

          v.FIT,
          v.MISC,
          v.LongStay,
          v.CBFD,
          v.CBFF,
          v.PotentialRm,
          v.IsBanqueting,

          v.CreatedDate

        FROM DailySalesReport.DailySalesReport_Tbl_Account_Visit AS v

        LEFT JOIN BQ_Tbl_Account_Master AS am
          ON v.AccountID = am.ID

        LEFT JOIN BQ_Tbl_CompanyContact AS cm
          ON v.ContactID = cm.ID

        WHERE v.OrganizationID = @OrganizationID
          AND v.CreatedDate >= @FromDate
          AND v.CreatedDate < DATEADD(
            DAY, 1, @ToDate
          )

        ORDER BY
          v.CreatedDate DESC,
          v.ID DESC

        OFFSET @Offset ROWS
        FETCH NEXT @PageSize ROWS ONLY;
      `);

    // ========================================================
    // 7. Total Count
    // ========================================================

    const totalCount = Number(
      result.recordsets[0][0]?.TotalCount || 0
    );

    // ========================================================
    // 8. Response Mapping
    // ========================================================

    const visitDetails = result.recordsets[1].map(
      (row, index) => ({
        SrNo: offset + index + 1,

        VisitID: row.VisitID,
        OrganizationID: Number(row.OrganizationID),
        Hotel: row.Hotel ?? null,

        AccountID: row.AccountID ?? null,
        ContactID: row.ContactID ?? null,

        CompanyName: row.CompanyName ?? null,
        ContactName: row.ContactName || null,

        CommunicationMode:
          row.CommunicationMode ?? null,

        PotentialRm: row.PotentialRm ?? null,

        FIT: row.FIT ?? null,
        MISC: row.MISC ?? null,
        LongStay: row.LongStay ?? null,
        CBFD: row.CBFD ?? null,
        CBFF: row.CBFF ?? null,
        IsBanqueting: row.IsBanqueting ?? null,

        VisitDate: row.VisitDate ?? null,

        NextFollowUpDate:
          row.NextFollowUpDate ?? null,

        Remarks: row.Remarks ?? null,
        Username: row.Username ?? null,
        GuestResponse: row.GuestResponse ?? null,

        CreatedDate: row.CreatedDate ?? null,
      })
    );

    // ========================================================
    // 9. Response
    // ========================================================

    return ok(
      "CEO DSR visit details fetched successfully.",
      visitDetails,
      {
        Filter: filter,
        OrganizationID: organizationID,

        Hotel: visitDetails[0]?.Hotel ?? null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalCount: totalCount,
        page: page,
        PageSize: pageSize,
        TotalPages: Math.ceil(totalCount / pageSize),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO DSR visit details"
    );
  }
};
// 6. ============================================================ Total SRMS Requests
const getCEOSRMSRequests = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"].includes(filter)
    ) {
      return fail("Invalid SRMS filter.", 400);
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    const request = mssqlPool
      .request()
      .input("FromDate", sql.Date, dates.CurrentFromDate)
      .input("ToDate", sql.Date, dates.CurrentToDate);

    if (organizationID) {
      request.input(
        "OrganizationID",
        sql.BigInt,
        organizationID
      );
    }

    // ========================================================
    // 5. Dynamic Organization Filter
    // ========================================================

    const orgFilter = organizationID
      ? "AND OrganizationID = @OrganizationID"
      : "";

    const hotelOrgFilter = organizationID
      ? "AND b.OrganizationID = @OrganizationID"
      : "";

    // ========================================================
    // 6. MSSQL Query
    // ========================================================

    const result = await request.query(`
      SELECT
        b.OrganizationID,

        dbo.FN_Get_OrganizationShortName(
          b.OrganizationID
        ) AS Hotel,

        ISNULL(a.Total, 0) AS Total

      FROM dbo.htl_tbl_organization_master b

      LEFT JOIN (
        SELECT
          OrganizationID,
          COUNT(ServiceRequestID) AS Total

        FROM SRMS.VW_ServiceRequest_Report_Master

        WHERE RequestDate >= @FromDate
          AND RequestDate < DATEADD(DAY, 1, @ToDate)
          ${orgFilter}

        GROUP BY OrganizationID
      ) a
        ON a.OrganizationID = b.OrganizationID

      WHERE b.Activation_status = 1
        AND b.IsNileHotel = 1
        ${hotelOrgFilter}

      ORDER BY Hotel;
    `);

    // ========================================================
    // 7. Response Mapping
    // ========================================================

    const chartData = result.recordset.map((row) => ({
      OrganizationID: Number(row.OrganizationID),
      Hotel: row.Hotel || null,
      Total: Number(row.Total || 0),
      Balancelaeb: Math.abs(Number(row.Total || 0)) >= 1000 &&
        Math.abs(Number(row.Total || 0)) < 100000
        ? `${Number((Number(row.Total) / 1000).toFixed(1))}K`
        : formatARBalanceLabel(row.Total),
    }));

    // ========================================================
    // 8. Response
    // ========================================================

    return ok(
      "CEO SRMS request count fetched successfully.",
      chartData,
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalOrganizations: chartData.length,

        TotalRequests: chartData.reduce(
          (sum, row) => sum + row.Total,
          0
        ),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO SRMS request count"
    );
  }
};
// 6.1. ============================================================ Total SRMS Requests Details
const getCEOSRMSRequestDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Pagination Validation
    // ========================================================

    const page = Number(data.page ?? 1);
    const pageSize = Number(data.PageSize ?? 10);

    if (
      !Number.isSafeInteger(page) ||
      page <= 0
    ) {
      return fail("Invalid page number.", 400);
    }

    if (
      !Number.isSafeInteger(pageSize) ||
      pageSize <= 0 ||
      pageSize > 100
    ) {
      return fail(
        "PageSize must be between 1 and 100.",
        400
      );
    }

    const offset = (page - 1) * pageSize;

    if (
      !Number.isSafeInteger(offset) ||
      offset > 2147483647
    ) {
      return fail("Pagination offset is too large.", 400);
    }

    // ========================================================
    // 4. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 5. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 6. MSSQL Query
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .input("FromDate", sql.Date, dates.CurrentFromDate)
      .input("ToDate", sql.Date, dates.CurrentToDate)
      .input("Offset", sql.Int, offset)
      .input("PageSize", sql.Int, pageSize)
      .query(`
        -- ============================================
        -- TOTAL COUNT
        -- ============================================

        SELECT
          COUNT_BIG(*) AS TotalCount

        FROM SRMS.VW_ServiceRequest_Report_Master AS sr

        INNER JOIN dbo.htl_tbl_organization_master AS org
          ON sr.OrganizationID = org.OrganizationID

        WHERE org.Activation_status = 1
          AND org.IsNileHotel = 1

          AND (
            @OrganizationID IS NULL
            OR sr.OrganizationID = @OrganizationID
          )

          AND sr.RequestDate >= @FromDate
          AND sr.RequestDate < DATEADD(DAY, 1, @ToDate);


        -- ============================================
        -- SRMS REQUEST DETAILS
        -- ============================================

        SELECT
          org.OrganizationID,

          dbo.FN_Get_OrganizationShortName(
            org.OrganizationID
          ) AS Hotel,

          sr.ServiceRequestID,
          sr.Location,
          sr.CallDescription,
          sr.Department,

          sr.RequestDate,
          sr.RequestDateTime,

          CONVERT(
            VARCHAR(20),
            sr.RequestDateTime,
            100
          ) AS RequestOn,

          sr.Status AS StatusCode,

          CASE
            WHEN sr.Status = 200 THEN 'Completed'
            WHEN sr.Status = 0 THEN 'Not Assigned'
            WHEN sr.Status = 1 THEN 'Pending'
            WHEN sr.Status = 100 THEN 'Park'
            ELSE ''
          END AS Status,

          sr.AssignedUserName,

          sr.CompleteDateTime,

          ISNULL(
            CONVERT(
              VARCHAR(20),
              sr.CompleteDateTime,
              100
            ),
            ''
          ) AS CompletedOn,

          ISNULL(
            sr.CompleteDurestion,
            ''
          ) AS CompleteDurestion,

          CASE
            WHEN sr.RequestMode = 'c' THEN 'Glitch'
            WHEN sr.RequestMode = 'm' THEN 'Employee'
            ELSE 'Guest'
          END AS RequestMode

        FROM SRMS.VW_ServiceRequest_Report_Master AS sr

        INNER JOIN dbo.htl_tbl_organization_master AS org
          ON sr.OrganizationID = org.OrganizationID

        WHERE org.Activation_status = 1
          AND org.IsNileHotel = 1

          AND (
            @OrganizationID IS NULL
            OR sr.OrganizationID = @OrganizationID
          )

          AND sr.RequestDate >= @FromDate
          AND sr.RequestDate < DATEADD(DAY, 1, @ToDate)

        ORDER BY
          sr.RequestDateTime DESC,
          sr.ServiceRequestID DESC

        OFFSET @Offset ROWS
        FETCH NEXT @PageSize ROWS ONLY;
      `);

    // ========================================================
    // 7. Count
    // ========================================================

    const totalCount = Number(
      result.recordsets[0][0]?.TotalCount ?? 0
    );

    // ========================================================
    // 8. Response Mapping
    // ========================================================

    const requestDetails = result.recordsets[1].map(
      (row, index) => ({
        SrNo: offset + index + 1,

        OrganizationID: Number(row.OrganizationID),
        Hotel: row.Hotel ?? null,

        ServiceRequestID: row.ServiceRequestID,
        Location: row.Location ?? null,
        CallDescription: row.CallDescription ?? null,
        Department: row.Department ?? null,

        RequestDate: formatDate(row.RequestDate),

        RequestDateTime: formatDate(row.RequestDateTime, "DD MMM YYYY hh:mm:ss A"),
        RequestOn: formatDate(row.RequestDateTime, "DD MMM YYYY hh:mm A"),

        StatusCode: row.StatusCode,
        Status: row.Status,

        AssignedUserName: row.AssignedUserName ?? null,

        CompleteDateTime: formatDate(row.CompleteDateTime, "DD MMM YYYY hh:mm:ss A"),
        CompletedOn: formatDate(row.CompleteDateTime, "DD MMM YYYY hh:mm A") ?? "",

        CompleteDurestion: row.CompleteDurestion ?? "",

        RequestMode: row.RequestMode,
      })
    );

    // ========================================================
    // 9. Response
    // ========================================================

    return ok(
      "CEO SRMS request details fetched successfully.",
      requestDetails,
      {
        Filter: filter,
        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalCount: totalCount,
        page: page,
        PageSize: pageSize,
        TotalPages: Math.ceil(totalCount / pageSize),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO SRMS request details"
    );
  }
};
// 7. ============================================================ Top 20 SRMS Requests
const getCEOTop20SRMSRequests = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail("Invalid SRMS filter.", 400);
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    const request = mssqlPool
      .request()
      .input(
        "FromDate",
        sql.Date,
        dates.CurrentFromDate
      )
      .input(
        "ToDate",
        sql.Date,
        dates.CurrentToDate
      );

    request.input("OrganizationID", sql.BigInt, organizationID || null);

    // ========================================================
    // 6. MSSQL Query
    // ========================================================

    const result = await request.query(`
      SELECT TOP (20)
        a.CallDescription,
        COUNT(a.ServiceRequestID) AS TotalRequest

      FROM SRMS.SRMS_Tbl_ServiceRequest_Master a

      WHERE (@OrganizationID IS NULL OR a.OrganizationID = @OrganizationID)
        AND a.RequestDate >= @FromDate
        AND a.RequestDate < DATEADD(DAY, 1, @ToDate)

      GROUP BY a.CallDescription

      ORDER BY
        TotalRequest DESC,
        a.CallDescription ASC;
    `);

    // ========================================================
    // 7. Response Mapping
    // ========================================================

    const chartData = result.recordset.map((row) => ({
      CallDescription: row.CallDescription || null,
      TotalRequest: Number(row.TotalRequest || 0),
    }));

    // ========================================================
    // 8. Response
    // ========================================================

    return ok(
      "CEO top 20 SRMS requests fetched successfully.",
      chartData,
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalCategories: chartData.length,

        TotalTop20Requests: chartData.reduce(
          (sum, row) => sum + row.TotalRequest,
          0
        ),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO top 20 SRMS requests"
    );
  }
};
// 7.1. ============================================================ Top 20 SRMS Requests Details
const getCEOTop20SRMSRequestDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================
    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================
    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Request Validation
    // ========================================================
    const requestName = data.Request;

    if (
      typeof requestName !== "string" ||
      !requestName.trim() ||
      requestName.length > 500
    ) {
      return fail(
        "Request is required and must be within 500 characters.",
        400
      );
    }

    // ========================================================
    // 4. Pagination Validation
    // ========================================================
    const page = Number(data.page ?? 1);
    const pageSize = Number(data.PageSize ?? 10);

    if (!Number.isSafeInteger(page) || page <= 0) {
      return fail("Page must be a positive integer.", 400);
    }

    if (
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      return fail(
        "PageSize must be between 1 and 100.",
        400
      );
    }

    const offset = (page - 1) * pageSize;

    if (
      !Number.isSafeInteger(offset) ||
      offset > 2147483647
    ) {
      return fail("Pagination offset is too large.", 400);
    }

    // ========================================================
    // 5. Date Range
    // ========================================================
    const dates = getDateRange(filter);

    // ========================================================
    // 6. MSSQL Connection
    // ========================================================
    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 7. MSSQL Query
    // ========================================================
    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .input("Request", sql.VarChar(500), requestName)
      .input("FromDate", sql.Date, dates.CurrentFromDate)
      .input("ToDate", sql.Date, dates.CurrentToDate)
      .input("Offset", sql.Int, offset)
      .input("PageSize", sql.Int, pageSize)
      .query(`
        -- ================================================
        -- TOTAL REQUEST COUNT
        -- ================================================
        SELECT
          COUNT_BIG(*) AS TotalCount

        FROM SRMS.SRMS_Tbl_ServiceRequest_Master AS a

        WHERE
          (
            @OrganizationID IS NULL
            OR a.OrganizationID = @OrganizationID
          )

          AND a.CallDescription = @Request

          AND a.RequestDate >= @FromDate
          AND a.RequestDate < DATEADD(DAY, 1, @ToDate);


        -- ================================================
        -- TOP 20 SRMS REQUEST DETAILS
        -- ================================================
        SELECT
          a.OrganizationID,

          dbo.FN_Get_OrganizationShortName(
            a.OrganizationID
          ) AS Hotel,

          a.ServiceRequestID,
          a.ServiceRequestNumber,

          a.CallDescription,
          a.CallCategory,
          a.Location,
          a.Department,
          a.Priority,

          a.Remark,

          a.RequestDate,
          a.RequestDateTime,

          CONVERT(
            VARCHAR(20),
            a.RequestDateTime,
            100
          ) AS RequestOn,

          a.Status AS StatusCode,

          CASE
            WHEN a.Status = 200 THEN 'Completed'
            WHEN a.Status = 0 THEN 'Not Assigned'
            WHEN a.Status = 1 THEN 'Pending'
            WHEN a.Status = 100 THEN 'Park'
            ELSE ''
          END AS Status,

          a.CompleteBy,
          a.CompleteByID,
          a.CompleteDateTime,

          ISNULL(
            CONVERT(VARCHAR(20), a.CompleteDateTime, 100),
            ''
          ) AS CompletedOn,

          a.CompletedRemarks,

          CASE
            WHEN a.RequestMode = 'c' THEN 'Glitch'
            WHEN a.RequestMode = 'm' THEN 'Employee'
            ELSE 'Guest'
          END AS RequestMode

        FROM SRMS.SRMS_Tbl_ServiceRequest_Master AS a

        WHERE
          (
            @OrganizationID IS NULL
            OR a.OrganizationID = @OrganizationID
          )

          AND a.CallDescription = @Request

          AND a.RequestDate >= @FromDate
          AND a.RequestDate < DATEADD(DAY, 1, @ToDate)

        ORDER BY
          a.RequestDateTime DESC,
          a.ServiceRequestID DESC

        OFFSET @Offset ROWS
        FETCH NEXT @PageSize ROWS ONLY;
      `);

    // ========================================================
    // 8. Total Count
    // ========================================================
    const totalCount = Number(
      result.recordsets[0][0]?.TotalCount ?? 0
    );

    // ========================================================
    // 9. Response Mapping
    // ========================================================
    const requestDetails = result.recordsets[1].map(
      (row, index) => ({
        SrNo: offset + index + 1,

        OrganizationID: Number(row.OrganizationID),
        Hotel: row.Hotel ?? null,

        ServiceRequestID: row.ServiceRequestID,
        ServiceRequestNumber:
          row.ServiceRequestNumber ?? null,

        CallDescription: row.CallDescription ?? null,
        CallCategory: row.CallCategory ?? null,
        Location: row.Location ?? null,
        Department: row.Department ?? null,
        Priority: row.Priority ?? null,

        Remark: row.Remark ?? null,

        RequestDate: row.RequestDate
          ? new Date(row.RequestDate)
              .toISOString().slice(0, 10)
          : null,

        RequestDateTime: formatDate(row.RequestDateTime, "DD MMM YYYY hh:mm:ss A"),
        RequestOn: formatDate(row.RequestDateTime, "DD MMM YYYY hh:mm A"),

        StatusCode: row.StatusCode,
        Status: row.Status,

        CompleteBy: row.CompleteBy ?? null,
        CompleteByID: row.CompleteByID ?? null,
        CompleteDateTime: formatDate(row.CompleteDateTime, "DD MMM YYYY hh:mm:ss A"),
        CompletedOn: formatDate(row.CompleteDateTime, "DD MMM YYYY hh:mm A") ?? "",
        CompletedRemarks: row.CompletedRemarks ?? null,

        RequestMode: row.RequestMode,
      })
    );

    // ========================================================
    // 10. Response
    // ========================================================
    return ok(
      "CEO top 20 SRMS request details fetched successfully.",
      requestDetails,
      {
        Filter: filter,
        OrganizationID: organizationID || null,
        Request: requestName,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalCount: totalCount,
        page: page,
        PageSize: pageSize,
        TotalPages: Math.ceil(totalCount / pageSize),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO top 20 SRMS request details"
    );
  }
};
// 8. ============================================================ SRMS Requests Completion Duration in Minutes
const getCEOSRMSCompletionDuration = async (data) => {
  try {
    const rawOrganizationID = data.OrganizationID;
    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      ((typeof rawOrganizationID !== "string" && typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n)
    ) {
      return fail("OrganizationID must be a positive integer.", 400);
    }

    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 3. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 4. MSSQL Query
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "FromDate",
        sql.Date,
        dates.CurrentFromDate
      )
      .input(
        "ToDate",
        sql.Date,
        dates.CurrentToDate
      )
      .input("OrganizationID", sql.BigInt, organizationID || null)
      .query(`
        SELECT
          fns.CompleteDurestion,
          SUM(fns.TotalRequest) AS TotalRequest

        FROM
        (
          SELECT
            CASE
              WHEN f.CompleteDurestion < 1
                THEN '1'

              WHEN f.CompleteDurestion > 1
                AND f.CompleteDurestion <= 3
                THEN '2'

              WHEN f.CompleteDurestion > 3
                AND f.CompleteDurestion <= 6
                THEN '3'

              WHEN f.CompleteDurestion > 6
                AND f.CompleteDurestion <= 9
                THEN '4'

              WHEN f.CompleteDurestion > 9
                AND f.CompleteDurestion <= 12
                THEN '5'

              WHEN f.CompleteDurestion > 12
                AND f.CompleteDurestion <= 15
                THEN '6'

              WHEN f.CompleteDurestion > 15
                AND f.CompleteDurestion <= 18
                THEN '7'

              ELSE '8'
            END AS CompleteDurestion,

            f.TotalRequest

          FROM
          (
            SELECT
              ISNULL(a.CompleteDurestion, 0)
                AS CompleteDurestion,

              COUNT(a.ServiceRequestID)
                AS TotalRequest

            FROM SRMS.SRMS_Tbl_ServiceRequest_Stg_master_report a

            WHERE (@OrganizationID IS NULL OR a.OrganizationID = @OrganizationID)
              AND a.RequestDate >= @FromDate
              AND a.RequestDate < DATEADD(
                DAY, 1, @ToDate
              )

              AND a.Status = 200

            GROUP BY
              a.CompleteDurestion
          ) f
        ) fns

        GROUP BY
          fns.CompleteDurestion

        ORDER BY
          fns.CompleteDurestion;
      `);

    // ========================================================
    // 5. Response Mapping
    // ========================================================

    const chartData = result.recordset.map((row) => ({
      CompleteDurestion: String(row.CompleteDurestion),
      TotalRequest: Number(row.TotalRequest || 0),
    }));

    // ========================================================
    // 6. Response
    // ========================================================

    return ok(
      "CEO SRMS completion duration fetched successfully.",
      chartData,
      {
        Filter: filter,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalRequests: chartData.reduce(
          (sum, row) => sum + row.TotalRequest,
          0
        ),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO SRMS completion duration"
    );
  }
};
// 8.1. ============================================================ SRMS Requests Completion Duration in Minutes Details
const getCEOSRMSCompletionDurationDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
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
    // 2. CD Validation
    // ========================================================
    const cd = Number(data.CD);

    if (
      data.CD == null ||
      String(data.CD).trim() === "" ||
      !Number.isInteger(cd) ||
      cd < 1 ||
      cd > 8
    ) {
      return fail("CD must be an integer between 1 and 8.", 400);
    }

    // ========================================================
    // 3. OrganizationID Validation
    // ========================================================
    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 4. Pagination Validation
    // ========================================================
    const page = Number(data.page ?? 1);
    const pageSize = Number(data.PageSize ?? 10);

    if (
      !Number.isSafeInteger(page) ||
      page <= 0 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      return fail("Invalid page or PageSize.", 400);
    }

    const offset = (page - 1) * pageSize;

    if (
      !Number.isSafeInteger(offset) ||
      offset > 2147483647
    ) {
      return fail("Pagination offset is too large.", 400);
    }

    // ========================================================
    // 5. Date Range (Existing Helper)
    // ========================================================
    const dates = getDateRange(filter);

    // ========================================================
    // 6. MSSQL Connection
    // ========================================================
    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 7. MSSQL Query
    // ========================================================
    const result = await mssqlPool
      .request()
      .input("OrganizationID", sql.BigInt, organizationID || null)
      .input("CD", sql.Int, cd)
      .input("FromDate", sql.Date, dates.CurrentFromDate)
      .input("ToDate", sql.Date, dates.CurrentToDate)
      .input("Offset", sql.Int, offset)
      .input("PageSize", sql.Int, pageSize)
      .query(`
        -- ============================================
        -- TOTAL COUNT
        -- ============================================
        SELECT
          COUNT_BIG(*) AS TotalCount

        FROM SRMS.VW_ServiceRequest_Master AS a

        WHERE
          (
            @OrganizationID IS NULL
            OR a.OrganizationID = @OrganizationID
          )

          AND a.RequestDate >= @FromDate
          AND a.RequestDate < DATEADD(DAY, 1, @ToDate)

          AND a.Status = 200

          AND (
            (@CD = 1 AND ISNULL(a.CompleteDurestion, 0) < 1)
            OR
            (@CD = 2 AND a.CompleteDurestion > 1
                     AND a.CompleteDurestion <= 3)
            OR
            (@CD = 3 AND a.CompleteDurestion > 3
                     AND a.CompleteDurestion <= 6)
            OR
            (@CD = 4 AND a.CompleteDurestion > 6
                     AND a.CompleteDurestion <= 9)
            OR
            (@CD = 5 AND a.CompleteDurestion > 9
                     AND a.CompleteDurestion <= 12)
            OR
            (@CD = 6 AND a.CompleteDurestion > 12
                     AND a.CompleteDurestion <= 15)
            OR
            (@CD = 7 AND a.CompleteDurestion > 15
                     AND a.CompleteDurestion <= 18)
            OR
            (@CD = 8 AND a.CompleteDurestion > 18)
          );

        -- ============================================
        -- COMPLETION DURATION DETAILS
        -- ============================================
        SELECT
          a.OrganizationID,

          dbo.FN_Get_OrganizationShortName(
            a.OrganizationID
          ) AS Hotel,

          a.ServiceRequestID,
          a.CallDescription,
          a.Location,
          a.Remark,
          a.RequestDate,

          CONVERT(
            VARCHAR(20),
            a.RequestDateTime,
            100
          ) AS RequestDateTime,

          a.AssignedUserName,
          a.CompleteBy,

          CONVERT(
            VARCHAR(20),
            a.CompleteDateTime,
            100
          ) AS CompleteDateTime,

          a.CompleteDurestion,

          CASE
            WHEN a.RequestMode = 'c' THEN 'Glitch'
            WHEN a.RequestMode = 'm' THEN 'Employee'
            ELSE 'Guest'
          END AS RequestMode

        FROM SRMS.VW_ServiceRequest_Master AS a

        WHERE
          (
            @OrganizationID IS NULL
            OR a.OrganizationID = @OrganizationID
          )

          AND a.RequestDate >= @FromDate
          AND a.RequestDate < DATEADD(DAY, 1, @ToDate)

          AND a.Status = 200

          AND (
            (@CD = 1 AND ISNULL(a.CompleteDurestion, 0) < 1)
            OR
            (@CD = 2 AND a.CompleteDurestion > 1
                     AND a.CompleteDurestion <= 3)
            OR
            (@CD = 3 AND a.CompleteDurestion > 3
                     AND a.CompleteDurestion <= 6)
            OR
            (@CD = 4 AND a.CompleteDurestion > 6
                     AND a.CompleteDurestion <= 9)
            OR
            (@CD = 5 AND a.CompleteDurestion > 9
                     AND a.CompleteDurestion <= 12)
            OR
            (@CD = 6 AND a.CompleteDurestion > 12
                     AND a.CompleteDurestion <= 15)
            OR
            (@CD = 7 AND a.CompleteDurestion > 15
                     AND a.CompleteDurestion <= 18)
            OR
            (@CD = 8 AND a.CompleteDurestion > 18)
          )

        ORDER BY
          a.OrganizationID,
          a.RequestDateTime DESC,
          a.ServiceRequestID DESC

        OFFSET @Offset ROWS
        FETCH NEXT @PageSize ROWS ONLY;
      `);

    // ========================================================
    // 8. Total Count
    // ========================================================
    const totalCount = Number(
      result.recordsets[0][0]?.TotalCount ?? 0
    );

    // ========================================================
    // 9. Response Mapping
    // ========================================================
    const details = result.recordsets[1].map((row, index) => ({
      SrNo: offset + index + 1,

      OrganizationID: Number(row.OrganizationID),
      Hotel: row.Hotel ?? null,

      ServiceRequestID: row.ServiceRequestID,
      CallDescription: row.CallDescription ?? null,
      Location: row.Location ?? null,
      Remark: row.Remark ?? null,

      RequestDate: row.RequestDate
        ? new Date(row.RequestDate).toISOString().slice(0, 10)
        : null,

      RequestDateTime: row.RequestDateTime ?? null,

      AssignedUserName: row.AssignedUserName ?? null,
      CompleteBy: row.CompleteBy ?? null,

      CompleteDateTime: row.CompleteDateTime ?? null,

      CompleteDurestion: row.CompleteDurestion ?? null,
      RequestMode: row.RequestMode,
    }));

    // ========================================================
    // 10. Response
    // ========================================================
    return ok(
      "CEO SRMS completion duration details fetched successfully.",
      details,
      {
        Filter: filter,
        CD: cd,
        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalCount: totalCount,
        page: page,
        PageSize: pageSize,
        TotalPages: Math.ceil(totalCount / pageSize),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO SRMS completion duration details"
    );
  }
};
// 9. ============================================================ Guest Met Trend
const getCEOGuestMetChart = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail("Invalid Guest Met filter.", 400);
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. PostgreSQL Query
    // ========================================================

    const result = await pool.query(
      `
        SELECT
          organization.OrganizationID,
          organization.ShortName,

          COUNT(d.GMDetailID) FILTER (
            WHERE UPPER(TRIM(d.MetOn)) = 'ARRIVAL'
          )::BIGINT AS Arrival,

          COUNT(d.GMDetailID) FILTER (
            WHERE UPPER(TRIM(d.MetOn)) = 'DEPARTURE'
          )::BIGINT AS Departure,

          COUNT(d.GMDetailID) FILTER (
            WHERE UPPER(TRIM(d.MetOn)) IN ('IN-HOUSE', 'IN HOUSE')
          )::BIGINT AS InHouse,

          COUNT(d.GMDetailID) FILTER (
            WHERE UPPER(TRIM(d.MetOn)) IN (
              'ARRIVAL', 'DEPARTURE', 'IN-HOUSE', 'IN HOUSE'
            )
          )::BIGINT AS Total

        FROM Organization_Master AS organization
        LEFT JOIN guestmeet_daily_entry_master m
          ON m.OrganizationID = organization.OrganizationID
          AND m.IsDeleted = FALSE
          AND m.EntryDate >= $1::DATE
          AND m.EntryDate <= $2::DATE

        LEFT JOIN guestmeet_daily_entry_details d
          ON d.GMMasterID = m.GMMasterID
          AND d.OrganizationID = m.OrganizationID
          AND d.IsDeleted = FALSE

        WHERE (
            $3::BIGINT IS NULL
            OR organization.OrganizationID = $3::BIGINT
          )

        GROUP BY
          organization.OrganizationID,
          organization.ShortName

        ORDER BY organization.OrganizationID ASC;
      `,
      [
        dates.CurrentFromDate,
        dates.CurrentToDate,
        organizationID || null,
      ]
    );

    // ========================================================
    // 5. Response Mapping
    // ========================================================

    const chartData = result.rows.map((row) => ({
      OrganizationID: Number(row.organizationid),
      OrganizationShortName: row.shortname ?? null,

      Arrival: Number(row.arrival),
      Departure: Number(row.departure),
      InHouse: Number(row.inhouse),
      Total: Number(row.total),
    }));

    // ========================================================
    // 6. Response
    // ========================================================

    return ok(
      "CEO guest met chart fetched successfully.",
      chartData,
      {
        Filter: filter,
        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalOrganizations: chartData.length,

        TotalArrival: chartData.reduce(
          (sum, row) => sum + row.Arrival, 0
        ),

        TotalDeparture: chartData.reduce(
          (sum, row) => sum + row.Departure, 0
        ),

        TotalInHouse: chartData.reduce(
          (sum, row) => sum + row.InHouse, 0
        ),

        TotalGuestMet: chartData.reduce(
          (sum, row) => sum + row.Total, 0
        ),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO guest met chart"
    );
  }
};
// 9.1. ============================================================ Guest Met Details
const getCEOGuestMetDetails = async (data) => {
  try {
    // ========================================================
    // 1. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      !/^[1-9]\d*$/.test(organizationID) ||
      BigInt(organizationID) > 9223372036854775807n
    ) {
      return fail("Valid OrganizationID is required.", 400);
    }

    // ========================================================
    // 2. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail("Invalid Guest Met date filter.", 400);
    }

    // ========================================================
    // 3. MetOn Validation
    // ========================================================

    const metOn = String(data.MetOn || "Total")
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, "");

    if (
      !["ARRIVAL", "DEPARTURE", "INHOUSE", "TOTAL"]
        .includes(metOn)
    ) {
      return fail(
        "MetOn must be Arrival, Departure, InHouse or Total.",
        400
      );
    }

    // ========================================================
    // 4. Pagination
    // ========================================================

    const page = Number(data.page ?? 1);
    const pageSize = Number(data.PageSize ?? 10);

    if (
      !Number.isSafeInteger(page) ||
      page <= 0 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      return fail("Invalid page or PageSize.", 400);
    }

    const offset = (page - 1) * pageSize;

    if (!Number.isSafeInteger(offset) || offset > 2147483647) {
      return fail("Pagination offset is too large.", 400);
    }

    // ========================================================
    // 5. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 6. PostgreSQL Query
    // ========================================================

    const result = await pool.query(
      `
        WITH GuestDetails AS (
          SELECT
            d.GMDetailID,
            d.GMMasterID,
            d.OrganizationID,
            o.ShortName AS OrganizationShortName,

            d.GuestName,
            d.RoomNo,
            d.BookingSource,
            d.Arrival,
            d.Departure,
            d.Feedback,
            d.ActionTaken,
            d.MetBy,
            d.MetOn,
            d.FeedbackType,
            d.GuestStatus,
            d.CreatedBy,
            d.CreatedDate,
            d.ModifiedBy,
            d.ModifiedDate,

            m.EntryDate,

            UPPER(
              REPLACE(
                REPLACE(TRIM(COALESCE(d.MetOn, '')), '-', ''),
                ' ',
                ''
              )
            ) AS NormalizedMetOn

          FROM guestmeet_daily_entry_details d

          INNER JOIN guestmeet_daily_entry_master m
            ON m.GMMasterID = d.GMMasterID
            AND m.OrganizationID = d.OrganizationID

          LEFT JOIN Organization_Master o
            ON o.OrganizationID = d.OrganizationID

          WHERE d.IsDeleted = FALSE
            AND m.IsDeleted = FALSE
            AND d.OrganizationID = $1::BIGINT
            AND m.EntryDate >= $2::DATE
            AND m.EntryDate <= $3::DATE
        )

        SELECT
          *,
          COUNT(*) OVER()::BIGINT AS TotalCount

        FROM GuestDetails

        WHERE
          (
            $4::TEXT = 'TOTAL'
            AND NormalizedMetOn IN (
              'ARRIVAL',
              'DEPARTURE',
              'INHOUSE'
            )
          )
          OR
          (
            $4::TEXT <> 'TOTAL'
            AND NormalizedMetOn = $4::TEXT
          )

        ORDER BY
          EntryDate DESC,
          CreatedDate DESC,
          GMDetailID DESC

        LIMIT $5
        OFFSET $6;
      `,
      [
        organizationID,
        dates.CurrentFromDate,
        dates.CurrentToDate,
        metOn,
        pageSize,
        offset,
      ]
    );

    // ========================================================
    // 7. Total Count
    // ========================================================

    let totalCount = Number(
      result.rows[0]?.totalcount ?? 0
    );

    // Handle empty pages
    if (!result.rows.length) {
      const countResult = await pool.query(
        `
          SELECT COUNT(*)::BIGINT AS TotalCount

          FROM guestmeet_daily_entry_details d

          INNER JOIN guestmeet_daily_entry_master m
            ON m.GMMasterID = d.GMMasterID
            AND m.OrganizationID = d.OrganizationID

          WHERE d.IsDeleted = FALSE
            AND m.IsDeleted = FALSE
            AND d.OrganizationID = $1::BIGINT
            AND m.EntryDate >= $2::DATE
            AND m.EntryDate <= $3::DATE

            AND (
              (
                $4::TEXT = 'TOTAL'
                AND UPPER(
                  REPLACE(
                    REPLACE(TRIM(COALESCE(d.MetOn, '')), '-', ''),
                    ' ',
                    ''
                  )
                ) IN ('ARRIVAL', 'DEPARTURE', 'INHOUSE')
              )
              OR
              (
                $4::TEXT <> 'TOTAL'
                AND UPPER(
                  REPLACE(
                    REPLACE(TRIM(COALESCE(d.MetOn, '')), '-', ''),
                    ' ',
                    ''
                  )
                ) = $4::TEXT
              )
            );
        `,
        [
          organizationID,
          dates.CurrentFromDate,
          dates.CurrentToDate,
          metOn,
        ]
      );

      totalCount = Number(countResult.rows[0].totalcount);
    }

    // ========================================================
    // 8. Response Mapping
    // ========================================================

    const guestDetails = result.rows.map((row, index) => ({
      SrNo: offset + index + 1,

      GMDetailID: Number(row.gmdetailid),
      GMMasterID: Number(row.gmmasterid),
      OrganizationID: Number(row.organizationid),
      OrganizationShortName: row.organizationshortname ?? null,

      GuestName: row.guestname ?? null,
      RoomNo: row.roomno ?? null,
      BookingSource: row.bookingsource ?? null,

      Arrival: row.arrival
        ? row.arrival.toISOString().slice(0, 10)
        : null,

      Departure: row.departure
        ? row.departure.toISOString().slice(0, 10)
        : null,

      Feedback: row.feedback ?? null,
      ActionTaken: row.actiontaken ?? null,
      MetBy: row.metby == null ? null : Number(row.metby),
      MetOn: row.meton ?? null,
      FeedbackType: row.feedbacktype ?? null,
      GuestStatus: row.gueststatus ?? null,

      EntryDate: row.entrydate
        ? row.entrydate.toISOString().slice(0, 10)
        : null,

      CreatedBy: row.createdby == null
        ? null
        : Number(row.createdby),

      CreatedDate: row.createddate ?? null,

      ModifiedBy: row.modifiedby == null
        ? null
        : Number(row.modifiedby),

      ModifiedDate: row.modifieddate ?? null,
    }));

    // ========================================================
    // 9. Response
    // ========================================================

    return ok(
      "CEO guest met details fetched successfully.",
      guestDetails,
      {
        OrganizationID: organizationID,
        OrganizationShortName:
          guestDetails[0]?.OrganizationShortName ?? null,

        Filter: filter,
        MetOn: metOn === "INHOUSE" ? "InHouse" :
          metOn === "TOTAL" ? "Total" :
          metOn === "ARRIVAL" ? "Arrival" : "Departure",

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalCount: totalCount,
        page: page,
        PageSize: pageSize,
        TotalPages: Math.ceil(totalCount / pageSize),
      }
    );

  } catch (error) {
    return databaseFailure(error, "Fetch CEO guest met details");
  }
};
// 10. ============================================================ AR Collection
const formatARBalanceLabel = (balance) => {
  const amount = Number(balance || 0);
  const absoluteAmount = Math.abs(amount);

  if (absoluteAmount >= 10000000) {
    return `${Number((amount / 10000000).toFixed(1))}Cr`;
  }

  if (absoluteAmount >= 100000) {
    return `${Number((amount / 100000).toFixed(1))}L`;
  }

  return String(Number(amount.toFixed(2)));
};
const getCEOARCollection = async (data) => {
  try {
    // ========================================================
    // 1. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 2. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 3. MSSQL Query
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .query(`
        SELECT
          dbo.FN_Get_OrganizationShortName(
            org.OrganizationID
          ) AS HTL,

          org.OrganizationID,

          ISNULL(ar.BALANCE, 0) AS BALANCE

        FROM dbo.htl_tbl_organization_master AS org

        LEFT JOIN
        (
          SELECT
            a.OrganizationID,

            SUM(ISNULL(b.Day91, 0)) AS BALANCE

          FROM FinanceDailyReport.FinanceDailyReport_Tbl_Entry_Master AS a

          INNER JOIN FinanceDailyReport.FinanceDailyReport_Tbl_Entry_Details AS b
            ON a.EntryID = b.EntryID

          WHERE a.IsDelete = 0
            AND b.Account NOT LIKE '%zzz%'
            AND a.ReportType = 'Aging Report'
            AND b.Day91 > 0

          GROUP BY
            a.OrganizationID

        ) AS ar
          ON org.OrganizationID = ar.OrganizationID

        WHERE org.Activation_Status = 1
          AND org.IsNileHotel = 1

          AND (
            @OrganizationID IS NULL
            OR org.OrganizationID = @OrganizationID
          )

        ORDER BY HTL;
      `);

    // ========================================================
    // 4. Response Mapping
    // ========================================================

    const chartData = result.recordset.map((row) => ({
      OrganizationID: Number(row.OrganizationID),
      Hotel: row.HTL || null,
      Balance: Number(row.BALANCE || 0),
      Balancelaeb: Math.abs(Number(row.BALANCE || 0)) >= 1000 &&
        Math.abs(Number(row.BALANCE || 0)) < 100000
        ? `${Number((Number(row.BALANCE) / 1000).toFixed(1))}K`
        : formatARBalanceLabel(row.BALANCE),
    }));

    // ========================================================
    // 5. Response
    // ========================================================

    return ok(
      "CEO AR collection fetched successfully.",
      chartData,
      {
        OrganizationID: organizationID || null,

        TotalOrganizations: chartData.length,

        TotalBalance: chartData.reduce(
          (sum, row) => sum + row.Balance,
          0
        ),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO AR collection"
    );
  }
};
// 10.1. ============================================================ AR Collection Details
const getCEOARCollectionDetails = async (data) => {
  try {
    // ========================================================
    // 1. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 2. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 3. MSSQL Query
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .query(`
        SELECT
          CASE
            WHEN GROUPING(b.Account) = 1
              THEN 'TOTAL'
            ELSE b.Account
          END AS Account,

          SUM(ISNULL(b.Day91, 0))
            AS [91 Days and Above],

          SUM(ISNULL(b.TotalPending, 0))
            AS [Total Pending],

          GROUPING(b.Account) AS IsTotalRow

        FROM FinanceDailyReport.FinanceDailyReport_Tbl_Entry_Master AS a

        INNER JOIN FinanceDailyReport.FinanceDailyReport_Tbl_Entry_Details AS b
          ON a.EntryID = b.EntryID

        INNER JOIN dbo.htl_tbl_organization_master AS org
          ON a.OrganizationID = org.OrganizationID

        WHERE a.IsDelete = 0
          AND a.ReportType = 'Aging Report'
          AND b.Account NOT LIKE '%zzz%'
          AND b.Day91 > 0

          AND org.Activation_Status = 1
          AND org.IsNileHotel = 1

          AND (
            @OrganizationID IS NULL
            OR org.OrganizationID = @OrganizationID
          )

        GROUP BY ROLLUP(b.Account)

        ORDER BY
          GROUPING(b.Account) ASC,
          b.Account ASC;
      `);

    // ========================================================
    // 4. Response Mapping
    // ========================================================

    const accountDetails = result.recordset
      .filter((row) => Number(row.IsTotalRow) === 0)
      .map((row, index) => ({
        SrNo: index + 1,
        Account: row.Account ?? null,
        Day91AndAbove: Number(row["91 Days and Above"] ?? 0),
        TotalPending: Number(row["Total Pending"] ?? 0),
      }));

    // ========================================================
    // 5. Grand Total
    // ========================================================

    const totalRow = result.recordset.find(
      (row) => Number(row.IsTotalRow) === 1
    );

    const grandTotal = {
      Account: "TOTAL",
      Day91AndAbove: Number(
        totalRow?.["91 Days and Above"] ?? 0
      ),
      TotalPending: Number(
        totalRow?.["Total Pending"] ?? 0
      ),
    };

    // ========================================================
    // 6. Response
    // ========================================================

    return ok(
      "CEO AR collection details fetched successfully.",
      {
        OrganizationID: organizationID || null,

        TotalAccounts: accountDetails.length,

        AccountDetails: accountDetails,

        GrandTotal: grandTotal,
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO AR collection details"
    );
  }
};
// 11. ============================================================ Paymaster Trend
const getCEOPayMasters = async (data) => {
  try {
    // ========================================================
    // 1. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 2. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 3. MSSQL Query
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .query(`
        SELECT
          dbo.FN_Get_OrganizationShortName(
            org.OrganizationID
          ) AS HTL,

          org.OrganizationID,

          ISNULL(pm.BALANCE, 0) AS BALANCE

        FROM dbo.htl_tbl_organization_master AS org

        LEFT JOIN
        (
          SELECT
            a.OrganizationID,

            SUM(ISNULL(b.BALANCE, 0)) AS BALANCE

          FROM FinanceDailyReport.FinanceDailyReport_Tbl_Entry_Master AS a

          INNER JOIN FinanceDailyReport.FinanceDailyReport_Tbl_Entry_PayMaster_Details AS b
            ON a.EntryID = b.EntryID

          WHERE a.IsDelete = 0
            AND b.Full_Name NOT LIKE '%zzz%'
            AND a.ReportType = 'Pay Master'
            AND b.BALANCE > 0

          GROUP BY
            a.OrganizationID

        ) AS pm
          ON org.OrganizationID = pm.OrganizationID

        WHERE org.Activation_Status = 1
          AND org.IsNileHotel = 1
          AND (
            @OrganizationID IS NULL
            OR org.OrganizationID = @OrganizationID
          )

        ORDER BY HTL;
      `);

    // ========================================================
    // 4. Response Mapping
    // ========================================================

    const chartData = result.recordset.map((row) => ({
      OrganizationID: Number(row.OrganizationID),
      Hotel: row.HTL || null,
      Balance: Number(row.BALANCE || 0),
      Balancelaeb: Math.abs(Number(row.BALANCE || 0)) >= 1000 &&
        Math.abs(Number(row.BALANCE || 0)) < 100000
        ? `${Number((Number(row.BALANCE) / 1000).toFixed(1))}K`
        : formatARBalanceLabel(row.BALANCE),
    }));

    // ========================================================
    // 5. Response
    // ========================================================

    return ok(
      "CEO Pay Masters fetched successfully.",
      chartData,
      {
        OrganizationID: organizationID || null,

        TotalOrganizations: chartData.length,

        TotalBalance: chartData.reduce(
          (sum, row) => sum + row.Balance,
          0
        ),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO Pay Masters"
    );
  }
};
// 11.1. ============================================================ Paymaster Details
const getCEOPayMastersDetails = async (data) => {
  try {
    // ========================================================
    // 1. OrganizationID Validation
    // ========================================================
    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 2. MSSQL Connection
    // ========================================================
    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 3. MSSQL Query
    // ========================================================
    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .query(`
        ;WITH PayMasterData AS
        (
          SELECT
            b.ROOM,
            b.FULL_NAME,
            b.COMPANY_NAME,
            b.BALANCE,
            b.ARRIVAL,
            b.DEPARTURE,

            CONVERT(
              VARCHAR(11),
              a.EntryDate,
              106
            ) AS LastupdateDate

          FROM FinanceDailyReport.FinanceDailyReport_Tbl_Entry_Master AS a

          INNER JOIN FinanceDailyReport.FinanceDailyReport_Tbl_Entry_PayMaster_Details AS b
            ON a.EntryID = b.EntryID

          INNER JOIN dbo.htl_tbl_organization_master AS org
            ON a.OrganizationID = org.OrganizationID

          WHERE a.IsDelete = 0
            AND a.ReportType = 'Pay Master'
            AND b.FULL_NAME NOT LIKE '%zzz%'
            AND b.BALANCE > 0

            AND org.Activation_Status = 1
            AND org.IsNileHotel = 1

            AND (
              @OrganizationID IS NULL
              OR a.OrganizationID = @OrganizationID
            )
        )

        SELECT
          ROOM,
          FULL_NAME,
          COMPANY_NAME,
          BALANCE,
          ARRIVAL,
          DEPARTURE,
          LastupdateDate,
          SortOrder

        FROM
        (
          -- ============================================
          -- DETAIL ROWS
          -- ============================================
          SELECT
            0 AS SortOrder,

            CAST(ROOM AS NVARCHAR(100)) AS ROOM,

            CAST(FULL_NAME AS NVARCHAR(MAX)) AS FULL_NAME,

            CAST(COMPANY_NAME AS NVARCHAR(MAX)) AS COMPANY_NAME,

            BALANCE,

            CAST(ARRIVAL AS NVARCHAR(50)) AS ARRIVAL,

            CAST(DEPARTURE AS NVARCHAR(50)) AS DEPARTURE,

            LastupdateDate

          FROM PayMasterData

          UNION ALL

          -- ============================================
          -- TOTAL ROW
          -- ============================================
          SELECT
            1 AS SortOrder,
            NULL AS ROOM,
            N'TOTAL' AS FULL_NAME,
            NULL AS COMPANY_NAME,
            SUM(BALANCE) AS BALANCE,
            NULL AS ARRIVAL,
            NULL AS DEPARTURE,
            NULL AS LastupdateDate

          FROM PayMasterData
        ) AS FinalResult

        ORDER BY
          SortOrder,
          FULL_NAME,
          ROOM;
      `);

    // ========================================================
    // 4. Response Mapping
    // ========================================================
    const payMasterDetails = result.recordset
      .filter((row) => Number(row.SortOrder) === 0)
      .map((row, index) => ({
        SrNo: index + 1,
        Room: row.ROOM ?? null,
        FullName: row.FULL_NAME ?? null,
        CompanyName: row.COMPANY_NAME ?? null,
        Balance: Number(row.BALANCE ?? 0),
        Arrival: row.ARRIVAL ?? null,
        Departure: row.DEPARTURE ?? null,
        LastupdateDate: row.LastupdateDate ?? null,
      }));

    // ========================================================
    // 5. Grand Total
    // ========================================================
    const totalRow = result.recordset.find(
      (row) => Number(row.SortOrder) === 1
    );

    const grandTotal = {
      FullName: "TOTAL",
      Balance: Number(totalRow?.BALANCE ?? 0),
    };

    // ========================================================
    // 6. Latest Updated Date
    // ========================================================
    const lastUpdatedResult = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .query(`
        SELECT
          CONVERT(
            VARCHAR(11),
            MAX(a.EntryDate),
            106
          ) AS LastUpdatedOn

        FROM FinanceDailyReport.FinanceDailyReport_Tbl_Entry_Master AS a

        INNER JOIN FinanceDailyReport.FinanceDailyReport_Tbl_Entry_PayMaster_Details AS b
          ON a.EntryID = b.EntryID

        INNER JOIN dbo.htl_tbl_organization_master AS org
          ON a.OrganizationID = org.OrganizationID

        WHERE a.IsDelete = 0
          AND a.ReportType = 'Pay Master'
          AND b.FULL_NAME NOT LIKE '%zzz%'
          AND b.BALANCE > 0
          AND org.Activation_Status = 1
          AND org.IsNileHotel = 1
          AND (
            @OrganizationID IS NULL
            OR a.OrganizationID = @OrganizationID
          );
      `);

    const lastUpdatedOn =
      lastUpdatedResult.recordset[0]?.LastUpdatedOn ?? null;

    // ========================================================
    // 7. Response
    // ========================================================
    return ok(
      "CEO Pay Masters details fetched successfully.",
      {
        OrganizationID: organizationID || null,
        LastUpdatedOn: lastUpdatedOn,
        TotalRecords: payMasterDetails.length,
        PayMasterDetails: payMasterDetails,
        GrandTotal: grandTotal,
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO Pay Masters details"
    );
  }
};
// 12. ============================================================ Forecast ADR
const getCEOForecastADR = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "tomorrow")
      .trim()
      .toLowerCase();

    if (
      !["tomorrow", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be tomorrow, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Forecast Date Range (India Timezone)
    // ========================================================

    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());

    const values = {};

    parts.forEach(({ type, value }) => {
      if (type !== "literal") {
        values[type] = Number(value);
      }
    });

    const year = values.year;
    const month = values.month;
    const day = values.day;

    const today = new Date(
      Date.UTC(year, month - 1, day)
    );

    const tomorrow = new Date(today);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

    let fromDate = new Date(tomorrow);
    let toDate = new Date(tomorrow);

    switch (filter) {
      case "tomorrow":
        break;

      case "weekly": {
        // Current calendar week: Monday through Sunday.
        const daysSinceMonday = (today.getUTCDay() + 6) % 7;
        fromDate = new Date(today);
        fromDate.setUTCDate(fromDate.getUTCDate() - daysSinceMonday);
        toDate = new Date(fromDate);
        toDate.setUTCDate(toDate.getUTCDate() + 6);
        break;
      }

      case "monthly":
        fromDate = new Date(Date.UTC(year, month - 1, 1));
        toDate = new Date(Date.UTC(year, month, 0));
        break;

      case "yearly":
        fromDate = new Date(Date.UTC(year, 0, 1));
        toDate = new Date(Date.UTC(year, 11, 31));
        break;
    }

    const fromDateString =
      fromDate.toISOString().slice(0, 10);

    const toDateString =
      toDate.toISOString().slice(0, 10);

    // ========================================================
    // 4. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 5. MSSQL Query
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .input("FromDate", sql.Date, fromDateString)
      .input("ToDate", sql.Date, toDateString)
      .query(`
        SELECT
          org.OrganizationID,

          org.ShortDisplayLabel AS Hotel,

          CONVERT(
            DECIMAL(12, 0),
            forecast.ADR
          ) AS ADR

        FROM dbo.htl_tbl_organization_master AS org

        LEFT JOIN
        (
          SELECT
            OrganizationID,

            AVG(
              TRY_CAST(
                ISNULL(ARR, 0) AS DECIMAL(12, 2)
              )
            ) AS ADR

          FROM PMSData.PMSData_IDS_Forecast_Report_Master

          WHERE [DATE] >= @FromDate
            AND [DATE] < DATEADD(DAY, 1, @ToDate)
            AND IsDeleted = 0

          GROUP BY OrganizationID

        ) AS forecast
          ON org.OrganizationID = forecast.OrganizationID

        WHERE org.Activation_status = 1
          AND org.IsNileHotel = 1

          AND (
            @OrganizationID IS NULL
            OR org.OrganizationID = @OrganizationID
          )

        ORDER BY org.ShortDisplayLabel;
      `);

    // ========================================================
    // 6. Response Mapping
    // ========================================================

    const chartData = result.recordset.map((row) => ({
      OrganizationID: Number(row.OrganizationID),
      Hotel: row.Hotel || null,

      ADR:
        row.ADR === null || row.ADR === undefined
          ? null
          : Number(row.ADR),
    }));

    // ========================================================
    // 7. Response
    // ========================================================

    return ok(
      "CEO forecast ADR fetched successfully.",
      chartData,
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: fromDateString,
          ToDate: toDateString,
        },

        TotalOrganizations: chartData.length,
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO forecast ADR"
    );
  }
};
// 13. ============================================================ PPM Rooms Trend
const getCEOPPMRooms = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 4. MSSQL Query
    // Date filtering matches supplied SQL Server logic.
    // ========================================================

    const result = await mssqlPool
      .request()
      .input("Filter", sql.VarChar(20), filter)
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .query(`
        DECLARE @Today DATE = CAST(GETDATE() AS DATE);
        DECLARE @StartDate DATE;
        DECLARE @EndDate DATE;

        IF @Filter = 'yesterday'
        BEGIN
          SET @StartDate = DATEADD(DAY, -1, @Today);
          SET @EndDate = @Today;
        END
        ELSE IF @Filter = 'weekly'
        BEGIN
          SET @StartDate = DATEADD(DAY, -6, @Today);
          SET @EndDate = DATEADD(DAY, 1, @Today);
        END
        ELSE IF @Filter = 'monthly'
        BEGIN
          SET @StartDate = DATEFROMPARTS(
            YEAR(@Today),
            MONTH(@Today),
            1
          );

          SET @EndDate = DATEADD(
            MONTH, 1, @StartDate
          );
        END
        ELSE IF @Filter = 'yearly'
        BEGIN
          SET @StartDate = DATEFROMPARTS(
            YEAR(@Today), 1, 1
          );

          SET @EndDate = DATEADD(
            YEAR, 1, @StartDate
          );
        END;

        SELECT
          org.OrganizationID,
          org.ShortDisplayLabel AS Hotel,
          COUNT(ppm.EntryID) AS Total

        FROM dbo.htl_tbl_organization_master AS org

        LEFT JOIN PPMChecklist.PPMChecklist_Tbl_Entry_Master AS ppm
          ON ppm.OrganizationID = org.OrganizationID
          AND ppm.EntryDate >= @StartDate
          AND ppm.EntryDate < @EndDate

        WHERE org.Activation_status = 1
          AND org.IsNileHotel = 1
          AND (
            @OrganizationID IS NULL
            OR org.OrganizationID = @OrganizationID
          )

        GROUP BY
          org.OrganizationID,
          org.ShortDisplayLabel

        ORDER BY
          org.ShortDisplayLabel ASC;
      `);

    // ========================================================
    // 5. Response Mapping
    // ========================================================

    const chartData = result.recordset.map((row) => ({
      OrganizationID: Number(row.OrganizationID),
      Hotel: row.Hotel || null,
      Total: Number(row.Total || 0),
    }));

    // ========================================================
    // 6. Response
    // ========================================================

    return ok(
      "CEO PPM rooms fetched successfully.",
      chartData,
      {
        Filter: filter,
        OrganizationID: organizationID || null,
        TotalOrganizations: chartData.length,

        TotalPPMRooms: chartData.reduce(
          (sum, row) => sum + row.Total,
          0
        ),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO PPM rooms"
    );
  }
};
// 13.1 ============================================================ PPM Rooms Details
const getCEOPPMChecklistDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Pagination Validation
    // ========================================================

    const page = Number(data.page ?? 1);
    const pageSize = Number(data.PageSize ?? 10);

    if (
      !Number.isSafeInteger(page) ||
      page <= 0 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      return fail(
        "Invalid page or PageSize.",
        400
      );
    }

    const offset = (page - 1) * pageSize;

    if (
      !Number.isSafeInteger(offset) ||
      offset > 2147483647 - pageSize
    ) {
      return fail(
        "Pagination offset is too large.",
        400
      );
    }

    // ========================================================
    // 4. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 5. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 6. MSSQL Query
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .input(
        "FromDate",
        sql.Date,
        dates.CurrentFromDate
      )
      .input(
        "ToDate",
        sql.Date,
        dates.CurrentToDate
      )
      .input("Offset", sql.Int, offset)
      .input("PageSize", sql.Int, pageSize)
      .query(`
        ;WITH PPMData AS
        (
          SELECT
            ROW_NUMBER() OVER (
              ORDER BY
                p.EntryDate DESC,
                p.EntryID DESC
            ) AS SrNo,

            p.OrganizationID,

            p.EntryID,

            p.RoomNumber,

            CONVERT(
              VARCHAR(11),
              p.EntryDate,
              106
            ) AS EntryDate,

            p.IsDoneEng,

            p.IsDoneHK

          FROM PPMChecklist.PPMChecklist_Tbl_Entry_Master AS p

          WHERE (
            @OrganizationID IS NULL
            OR p.OrganizationID = @OrganizationID
          )

          AND p.EntryDate >= @FromDate
          AND p.EntryDate < DATEADD(DAY, 1, @ToDate)
        )

        -- ====================================================
        -- RESULT SET 1: PAGINATED DETAILS
        -- ====================================================

        SELECT
          SrNo,
          OrganizationID,
          EntryID,
          RoomNumber,
          EntryDate,
          IsDoneEng,
          IsDoneHK

        FROM PPMData

        WHERE SrNo > @Offset
          AND SrNo <= @Offset + @PageSize

        ORDER BY SrNo;

        -- ====================================================
        -- RESULT SET 2: TOTAL COUNT
        -- ====================================================

        SELECT
          COUNT(*) AS TotalCount

        FROM PPMChecklist.PPMChecklist_Tbl_Entry_Master AS p

        WHERE (
          @OrganizationID IS NULL
          OR p.OrganizationID = @OrganizationID
        )

        AND p.EntryDate >= @FromDate
        AND p.EntryDate < DATEADD(DAY, 1, @ToDate);
      `);

    // ========================================================
    // 7. Total Count
    // ========================================================

    const totalCount = Number(
      result.recordsets?.[1]?.[0]?.TotalCount ?? 0
    );

    // ========================================================
    // 8. Response Mapping
    // ========================================================

    const ppmDetails = (
      result.recordsets?.[0] ?? []
    ).map((row) => ({
      SrNo: Number(row.SrNo),

      OrganizationID:
        row.OrganizationID == null
          ? null
          : String(row.OrganizationID),

      EntryID:
        row.EntryID == null
          ? null
          : String(row.EntryID),

      RoomNumber: row.RoomNumber ?? null,

      EntryDate: row.EntryDate ?? null,

      IsDoneEng: row.IsDoneEng ?? null,

      IsDoneHK: row.IsDoneHK ?? null,
    }));

    // ========================================================
    // 9. Response
    // ========================================================

    return ok(
      "CEO PPM checklist details fetched successfully.",
      ppmDetails,
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalCount: totalCount,

        page: page,

        PageSize: pageSize,

        TotalPages: Math.ceil(totalCount / pageSize),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO PPM checklist details"
    );
  }
};

// 14. ============================================================ Training Hours Trend
const getCEOTrainingHours = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range (Existing Helper)
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. MSSQL Query
    // ========================================================

    const mssqlPool = await getMssqlPool();

    const result = await mssqlPool
      .request()
      .input("FromDate", sql.Date, dates.CurrentFromDate)
      .input("ToDate", sql.Date, dates.CurrentToDate)
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .query(`
        SELECT
          org.OrganizationID,

          dbo.FN_Get_OrganizationShortName(
            org.OrganizationID
          ) AS Hotel,

          COUNT(training.ID) AS Total

        FROM dbo.htl_tbl_organization_master AS org

        LEFT JOIN
          TrainingSchedule.TrainingSchedule_Tbl_TrainingSchedule_Entry_Master
          AS training
          ON training.OrganizationID = org.OrganizationID
          AND training.[Date] >= @FromDate
          AND training.[Date] < DATEADD(DAY, 1, @ToDate)

        WHERE org.Activation_status = 1
          AND org.IsNileHotel = 1
          AND org.OrganizationID <> 3
          AND (
            @OrganizationID IS NULL
            OR org.OrganizationID = @OrganizationID
          )

        GROUP BY org.OrganizationID

        ORDER BY Hotel;
      `);

    // ========================================================
    // 5. Response Mapping
    // ========================================================

    const chartData = result.recordset.map((row) => ({
      OrganizationID: Number(row.OrganizationID),
      Hotel: row.Hotel || null,
      Total: Number(row.Total || 0),
    }));

    // ========================================================
    // 6. Response
    // ========================================================

    return ok(
      "CEO training hours fetched successfully.",
      chartData,
      {
        Filter: filter,
        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalOrganizations: chartData.length,

        TotalTrainingHours: chartData.reduce(
          (sum, row) => sum + row.Total,
          0
        ),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO training hours"
    );
  }
};
// 14.1. ============================================================ Training Hours Details
const getCEOTrainingHoursDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Pagination Validation
    // ========================================================

    const page = Number(data.page ?? 1);
    const pageSize = Number(data.PageSize ?? 10);

    if (
      !Number.isSafeInteger(page) ||
      page <= 0 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      return fail(
        "Invalid page or PageSize.",
        400
      );
    }

    const offset = (page - 1) * pageSize;

    if (
      !Number.isSafeInteger(offset) ||
      offset > 2147483647
    ) {
      return fail(
        "Pagination offset is too large.",
        400
      );
    }

    // ========================================================
    // 4. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 5. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 6. MSSQL Query
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .input(
        "FromDate",
        sql.Date,
        dates.CurrentFromDate
      )
      .input(
        "ToDate",
        sql.Date,
        dates.CurrentToDate
      )
      .input(
        "Offset",
        sql.Int,
        offset
      )
      .input(
        "PageSize",
        sql.Int,
        pageSize
      )
      .query(`
        ;WITH TrainingData AS
        (
          SELECT
            t.*,
            COUNT(*) OVER() AS TotalCount

          FROM TrainingSchedule.TrainingSchedule_Tbl_TrainingSchedule_Entry_Master AS t

          INNER JOIN dbo.htl_tbl_organization_master AS org
            ON t.OrganizationID = org.OrganizationID

          WHERE org.Activation_status = 1
            AND org.IsNileHotel = 1
            AND org.OrganizationID <> 3

            AND (
              @OrganizationID IS NULL
              OR t.OrganizationID = @OrganizationID
            )

            AND t.[Date] >= @FromDate
            AND t.[Date] < DATEADD(DAY, 1, @ToDate)
        )

        SELECT *
        FROM TrainingData

        ORDER BY
          OrganizationID,
          [Date] DESC,
          ID DESC

        OFFSET @Offset ROWS
        FETCH NEXT @PageSize ROWS ONLY;
      `);

    // ========================================================
    // 7. Total Count
    // ========================================================

    let totalCount = Number(
      result.recordset[0]?.TotalCount ?? 0
    );

    // Empty page count fallback
    if (!result.recordset.length) {
      const countResult = await mssqlPool
        .request()
        .input(
          "OrganizationID",
          sql.BigInt,
          organizationID || null
        )
        .input(
          "FromDate",
          sql.Date,
          dates.CurrentFromDate
        )
        .input(
          "ToDate",
          sql.Date,
          dates.CurrentToDate
        )
        .query(`
          SELECT
            COUNT(*) AS TotalCount

          FROM TrainingSchedule.TrainingSchedule_Tbl_TrainingSchedule_Entry_Master AS t

          INNER JOIN dbo.htl_tbl_organization_master AS org
            ON t.OrganizationID = org.OrganizationID

          WHERE org.Activation_status = 1
            AND org.IsNileHotel = 1
            AND org.OrganizationID <> 3

            AND (
              @OrganizationID IS NULL
              OR t.OrganizationID = @OrganizationID
            )

            AND t.[Date] >= @FromDate
            AND t.[Date] < DATEADD(DAY, 1, @ToDate);
        `);

      totalCount = Number(
        countResult.recordset[0]?.TotalCount ?? 0
      );
    }

    // ========================================================
    // 8. Response Mapping
    // ========================================================

    const excludedFields = new Set([
      "totalcount",

      // Previously removed fields
      "modifiedby",
      "modifieddate",
      "deletedby",
      "deleteddate",
      "departmentid",
      "isdeleted",
      "createdby",

      // Additional unwanted fields
      "createddateutc",
      "modifyby",
      "modifydate",
      "modifydateutc",
    ]);

    const trainingDetails = result.recordset.map(
      (row, index) => {
        const training = {};

        for (const [key, value] of Object.entries(row)) {
          const field = key.toLowerCase();

          // Remove unwanted fields
          if (excludedFields.has(field)) {
            continue;
          }

          // Format date fields
          if (
            value !== null &&
            value !== undefined &&
            (
              field === "date" ||
              field.endsWith("date")
            )
          ) {
            training[key] = formatDate(value);
          } else {
            training[key] = value;
          }
        }

        return {
          SrNo: offset + index + 1,
          ...training,
        };
      }
    );

    // ========================================================
    // 9. Response
    // ========================================================

    return ok(
      "CEO training hours details fetched successfully.",
      trainingDetails,
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalCount: totalCount,
        page: page,
        PageSize: pageSize,
        TotalPages: Math.ceil(totalCount / pageSize),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO training hours details"
    );
  }
};
// 15. ============================================================ Restaurant Feedback Trend
const getCEORestaurantFeedback = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range (Existing Helper)
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. MSSQL Query
    // ========================================================

    const mssqlPool = await getMssqlPool();

    const result = await mssqlPool
      .request()
      .input("FromDate", sql.Date, dates.CurrentFromDate)
      .input("ToDate", sql.Date, dates.CurrentToDate)
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .query(`
        SELECT
          org.OrganizationID,

          dbo.FN_Get_OrganizationShortName(
            org.OrganizationID
          ) AS Hotel,

          ISNULL(feedback.Total, 0) AS Total

        FROM dbo.htl_tbl_organization_master AS org

        LEFT JOIN
        (
          SELECT
            a.OrganizationID,
            COUNT(a.ID) AS Total

          FROM dbo.RT_TBL_Contact_VisitInforamtion AS a

          WHERE a.VisitDate >= @FromDate
            AND a.VisitDate < DATEADD(DAY, 1, @ToDate)

          GROUP BY a.OrganizationID

        ) AS feedback
          ON org.OrganizationID = feedback.OrganizationID

        WHERE org.Activation_status = 1
          AND org.IsNileHotel = 1
          AND org.OrganizationID <> 3

          AND (
            @OrganizationID IS NULL
            OR org.OrganizationID = @OrganizationID
          )

        ORDER BY Hotel;
      `);

    // ========================================================
    // 5. Response Mapping
    // ========================================================

    const chartData = result.recordset.map((row) => ({
      OrganizationID: Number(row.OrganizationID),
      Hotel: row.Hotel || null,
      Total: Number(row.Total || 0),
    }));

    // ========================================================
    // 6. Response
    // ========================================================

    return ok(
      "CEO restaurant feedback fetched successfully.",
      chartData,
      {
        Filter: filter,
        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalOrganizations: chartData.length,

        TotalFeedback: chartData.reduce(
          (sum, row) => sum + row.Total,
          0
        ),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO restaurant feedback"
    );
  }
};
// 15.1 ============================================================ Restaurant Feedback Details
const getCEORestaurantFeedbackDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Pagination Validation
    // ========================================================

    const page = Number(data.page ?? 1);
    const pageSize = Number(data.PageSize ?? 10);

    if (
      !Number.isSafeInteger(page) ||
      page <= 0 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      return fail(
        "Invalid page or PageSize.",
        400
      );
    }

    const offset = (page - 1) * pageSize;

    if (
      !Number.isSafeInteger(offset) ||
      offset > 2147483647
    ) {
      return fail(
        "Pagination offset is too large.",
        400
      );
    }

    // ========================================================
    // 4. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 5. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 6. MSSQL Query
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .input(
        "FromDate",
        sql.Date,
        dates.CurrentFromDate
      )
      .input(
        "ToDate",
        sql.Date,
        dates.CurrentToDate
      )
      .input("Offset", sql.Int, offset)
      .input("PageSize", sql.Int, pageSize)
      .query(`
        SELECT
          a.ID AS VisitID,

          a.OrganizationID,

          a.OverallExperienceComments,

          a.HearFrom,

          a.FoodType,

          CONVERT(
            VARCHAR(11),
            a.VisitDate,
            106
          ) AS VisitDate,

          -- CATEGORY-WISE FEEDBACK ATTRIBUTES
          JSON_QUERY(
            (
              SELECT
                cm.Title AS Category,
                b.Title AS Attribute,
                AD.Answer AS Response

              FROM dbo.RT_TBL_Contact_VisitInforamtion_Attribute_Details AS AD

              INNER JOIN dbo.RT_Tbl_Feedback_Grid_Attribute_Master AS b
                ON AD.AttributeID = b.AttributeID

              INNER JOIN dbo.RT_Tbl_Feedback_Grid_Category_Master AS cm
                ON cm.CategoryID = b.CategoryID

              WHERE AD.VisitID = a.ID

              FOR JSON PATH
            )
          ) AS FeedbackDetails,

          COUNT(*) OVER() AS TotalCount

        FROM dbo.RT_TBL_Contact_VisitInforamtion AS a

        WHERE (
          @OrganizationID IS NULL
          OR a.OrganizationID = @OrganizationID
        )

          AND a.VisitDate >= @FromDate
          AND a.VisitDate < DATEADD(DAY, 1, @ToDate)

        ORDER BY
          a.VisitDate DESC,
          a.ID DESC

        OFFSET @Offset ROWS
        FETCH NEXT @PageSize ROWS ONLY;
      `);

    // ========================================================
    // 7. Total Count
    // ========================================================

    let totalCount = Number(
      result.recordset[0]?.TotalCount ?? 0
    );

    // Empty page count fallback
    if (!result.recordset.length) {
      const countResult = await mssqlPool
        .request()
        .input(
          "OrganizationID",
          sql.BigInt,
          organizationID || null
        )
        .input(
          "FromDate",
          sql.Date,
          dates.CurrentFromDate
        )
        .input(
          "ToDate",
          sql.Date,
          dates.CurrentToDate
        )
        .query(`
          SELECT COUNT(*) AS TotalCount

          FROM dbo.RT_TBL_Contact_VisitInforamtion AS a

          WHERE (
            @OrganizationID IS NULL
            OR a.OrganizationID = @OrganizationID
          )

            AND a.VisitDate >= @FromDate
            AND a.VisitDate < DATEADD(DAY, 1, @ToDate);
        `);

      totalCount = Number(
        countResult.recordset[0]?.TotalCount ?? 0
      );
    }

    // ========================================================
    // 8. Response Mapping
    // ========================================================

    const feedbackDetails = result.recordset.map(
      (row, index) => {
        let attributes = [];

        try {
          attributes = row.FeedbackDetails
            ? JSON.parse(row.FeedbackDetails)
            : [];
        } catch {
          attributes = [];
        }

        // Group attributes category-wise
        const groupedFeedback = {};

        for (const item of attributes) {
          const category = item.Category || "Other";

          if (!groupedFeedback[category]) {
            groupedFeedback[category] = [];
          }

          groupedFeedback[category].push({
            Attribute: item.Attribute ?? null,
            Response: item.Response ?? null,
          });
        }

        return {
          SrNo: offset + index + 1,

          VisitID: String(row.VisitID),

          OrganizationID: String(row.OrganizationID),

          OverallExperienceComments:
            row.OverallExperienceComments ?? null,

          HearFrom: row.HearFrom ?? null,

          FoodType: row.FoodType ?? null,

          VisitDate: row.VisitDate ?? null,

          FeedbackDetails: Object.entries(
            groupedFeedback
          ).map(([Category, Attributes]) => ({
            Category,
            Attributes,
          })),
        };
      }
    );

    // ========================================================
    // 9. Response
    // ========================================================

    return ok(
      "CEO restaurant feedback details fetched successfully.",
      feedbackDetails,
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalCount: totalCount,

        page: page,

        PageSize: pageSize,

        TotalPages: Math.ceil(totalCount / pageSize),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO restaurant feedback details"
    );
  }
};
// 16. ============================================================ Consumption Trend
const getCEOConsumption = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range (Existing Helper)
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. MSSQL Query
    // ========================================================

    const mssqlPool = await getMssqlPool();

    const result = await mssqlPool
      .request()
      .input("FromDate", sql.Date, dates.CurrentFromDate)
      .input("ToDate", sql.Date, dates.CurrentToDate)
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .query(`
        SELECT
          org.OrganizationID,

          dbo.FN_Get_OrganizationShortName(
            org.OrganizationID
          ) AS Hotel,

          ISNULL(SUM(c.TotalAmount), 0) AS Total

        FROM dbo.htl_tbl_organization_master AS org

        LEFT JOIN FinanceDailyReport.FinanceDailyReport_Tbl_Entry_Master AS e
          ON e.OrganizationID = org.OrganizationID
          AND e.IsDelete = 0
          AND e.ReportType = 'Consumption'
          AND e.EntryDate >= @FromDate
          AND e.EntryDate < DATEADD(DAY, 1, @ToDate)

        LEFT JOIN FinanceDailyReport.FinanceDailyReport_Tbl_Consumption_Details AS c
          ON e.EntryID = c.EntryID

        WHERE org.Activation_status = 1
          AND org.IsNileHotel = 1
          AND org.OrganizationID <> 3
          AND (
            @OrganizationID IS NULL
            OR org.OrganizationID = @OrganizationID
          )

        GROUP BY org.OrganizationID

        ORDER BY Hotel;
      `);

    // ========================================================
    // 5. Response Mapping
    // ========================================================

    const chartData = result.recordset.map((row) => ({
      OrganizationID: Number(row.OrganizationID),
      Hotel: row.Hotel || null,
      Total: Number(row.Total || 0),
      Balancelaeb: Math.abs(Number(row.Total || 0)) >= 1000 &&
        Math.abs(Number(row.Total || 0)) < 100000
        ? `${Number((Number(row.Total) / 1000).toFixed(1))}K`
        : formatARBalanceLabel(row.Total),
    }));

    // ========================================================
    // 6. Response
    // ========================================================

    return ok(
      "CEO consumption fetched successfully.",
      chartData,
      {
        Filter: filter,
        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalOrganizations: chartData.length,

        TotalConsumption: chartData.reduce(
          (sum, row) => sum + row.Total,
          0
        ),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO consumption"
    );
  }
};
// 16.1. ============================================================ Consumption Details
const getCEOConsumptionDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. UserID Validation
    // ========================================================

    const rawUserID = data.UserID ?? 0;
    const userID = String(rawUserID).trim();

    if (
      !/^(0|[1-9]\d*)$/.test(userID) ||
      BigInt(userID) > 9223372036854775807n
    ) {
      return fail(
        "UserID must be zero or a positive integer.",
        400
      );
    }

    // ========================================================
    // 4. Pagination Validation
    // ========================================================

    const page = Number(data.page ?? 1);
    const pageSize = Number(data.PageSize ?? 100);

    if (
      !Number.isSafeInteger(page) ||
      page <= 0 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize <= 0 ||
      pageSize > 100
    ) {
      return fail(
        "Invalid page or PageSize.",
        400
      );
    }

    const offset = (page - 1) * pageSize;

    if (
      !Number.isSafeInteger(offset) ||
      offset > 2147483647 - pageSize
    ) {
      return fail(
        "Pagination offset is too large.",
        400
      );
    }

    // ========================================================
    // 5. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 6. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 7. MSSQL Query
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .input("UserID", sql.BigInt, userID)
      .input(
        "FromDate",
        sql.Date,
        dates.CurrentFromDate
      )
      .input(
        "ToDate",
        sql.Date,
        dates.CurrentToDate
      )
      .input("Offset", sql.Int, offset)
      .input("Limit", sql.Int, pageSize)
      .query(`
        ;WITH ConsumptionData AS
        (
          SELECT
            e.OrganizationID,
            c.Con_Date,
            c.ItemCode,
            c.Item,
            c.Department,
            c.Store,
            c.Type,
            c.Quantity,
            c.Rate,
            c.TotalAmount,
            c.UOM

          FROM FinanceDailyReport.FinanceDailyReport_Tbl_Entry_Master AS e

          INNER JOIN FinanceDailyReport.FinanceDailyReport_Tbl_Consumption_Details AS c
            ON e.EntryID = c.EntryID

          WHERE e.IsDelete = 0
            AND e.ReportType = 'Consumption'

            AND (
              @OrganizationID IS NULL
              OR e.OrganizationID = @OrganizationID
            )

            AND c.Con_Date >= @FromDate
            AND c.Con_Date < DATEADD(DAY, 1, @ToDate)

            AND c.Con_Date IS NOT NULL
            AND c.TotalAmount > 0

            AND (
              @UserID = 0
              OR c.Department IN
              (
                SELECT Department
                FROM InterviewAssessment.InterviewAssessment_Tbl_Position_User_RH_Department_Rights
                WHERE UserID = @UserID
              )
            )
        ),

        NumberedData AS
        (
          SELECT
            ROW_NUMBER() OVER (
              ORDER BY Con_Date DESC, ItemCode
            ) AS SrNo,

            OrganizationID,
            CONVERT(VARCHAR(11), Con_Date, 106) AS [Date],
            ItemCode,
            Item,
            Department,
            Store,
            Quantity,
            Rate,
            TotalAmount,
            Type,
            UOM

          FROM ConsumptionData
        ),

        PagedData AS
        (
          SELECT *
          FROM NumberedData
          WHERE SrNo > @Offset
            AND SrNo <= @Offset + @Limit
        ),

        FinalResult AS
        (
          SELECT
            0 AS SortOrder,
            CAST(SrNo AS BIGINT) AS SrNo,
            OrganizationID,
            [Date],
            CAST(ItemCode AS NVARCHAR(100)) AS ItemCode,
            CAST(Item AS NVARCHAR(MAX)) AS Item,
            CAST(Department AS NVARCHAR(MAX)) AS Department,
            CAST(Store AS NVARCHAR(MAX)) AS Store,
            Quantity,
            Rate,
            TotalAmount,
            CAST(Type AS NVARCHAR(MAX)) AS Type,
            CAST(UOM AS NVARCHAR(MAX)) AS UOM

          FROM PagedData

          UNION ALL

          SELECT
            1 AS SortOrder,
            NULL AS SrNo,
            NULL AS OrganizationID,
            NULL AS [Date],
            NULL AS ItemCode,
            N'TOTAL' AS Item,
            NULL AS Department,
            NULL AS Store,
            SUM(Quantity) AS Quantity,
            NULL AS Rate,
            SUM(TotalAmount) AS TotalAmount,
            NULL AS Type,
            NULL AS UOM

          FROM ConsumptionData
        )

        SELECT
          SortOrder,
          SrNo,
          OrganizationID,
          [Date],
          ItemCode,
          Item,
          Department,
          Store,
          Quantity,
          Rate,
          TotalAmount,
          Type,
          UOM

        FROM FinalResult

        ORDER BY SortOrder, SrNo;

        -- Overall record count for pagination
        SELECT COUNT(*) AS TotalCount
        FROM FinanceDailyReport.FinanceDailyReport_Tbl_Entry_Master AS e

        INNER JOIN FinanceDailyReport.FinanceDailyReport_Tbl_Consumption_Details AS c
          ON e.EntryID = c.EntryID

        WHERE e.IsDelete = 0
          AND e.ReportType = 'Consumption'

          AND (
            @OrganizationID IS NULL
            OR e.OrganizationID = @OrganizationID
          )

          AND c.Con_Date >= @FromDate
          AND c.Con_Date < DATEADD(DAY, 1, @ToDate)

          AND c.Con_Date IS NOT NULL
          AND c.TotalAmount > 0

          AND (
            @UserID = 0
            OR c.Department IN
            (
              SELECT Department
              FROM InterviewAssessment.InterviewAssessment_Tbl_Position_User_RH_Department_Rights
              WHERE UserID = @UserID
            )
          );
      `);

    // ========================================================
    // 8. Pagination Count
    // ========================================================

    const totalCount = Number(
      result.recordsets?.[1]?.[0]?.TotalCount ?? 0
    );

    // ========================================================
    // 9. Response Mapping
    // ========================================================

    const rows = result.recordsets?.[0] ?? [];

    const detailRows = rows.filter(
      (row) => Number(row.SortOrder) === 0
    );

    const totalRow = rows.find(
      (row) => Number(row.SortOrder) === 1
    );

    const consumptionDetails = detailRows.map((row) => ({
      SrNo: Number(row.SrNo),
      OrganizationID:
        row.OrganizationID == null
          ? null
          : String(row.OrganizationID),
      Date: row.Date ?? null,
      ItemCode: row.ItemCode ?? null,
      Item: row.Item ?? null,
      Department: row.Department ?? null,
      Store: row.Store ?? null,
      Quantity: Number(row.Quantity ?? 0),
      Rate: Number(row.Rate ?? 0),
      TotalAmount: Number(row.TotalAmount ?? 0),
      Type: row.Type ?? null,
      UOM: row.UOM ?? null,
    }));

    const grandTotal = {
      Item: "TOTAL",
      Quantity: Number(totalRow?.Quantity ?? 0),
      TotalAmount: Number(totalRow?.TotalAmount ?? 0),
    };

    // ========================================================
    // 10. Response
    // ========================================================

    return ok(
      "CEO consumption details fetched successfully.",
      {
        ConsumptionDetails: consumptionDetails,
        GrandTotal: grandTotal,
      },
      {
        Filter: filter,
        OrganizationID: organizationID || null,
        UserID: userID,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalCount: totalCount,
        page: page,
        PageSize: pageSize,
        TotalPages: Math.ceil(totalCount / pageSize),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO consumption details"
    );
  }
};
// 17. ============================================================ CheckList Trend
const getCEOCheckList = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "weekly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range (Existing Helper)
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. MSSQL Query
    // ========================================================

    const mssqlPool = await getMssqlPool();

    const result = await mssqlPool
      .request()
      .input("FromDate", sql.Date, dates.CurrentFromDate)
      .input("ToDate", sql.Date, dates.CurrentToDate)
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .query(`
        SELECT
          org.OrganizationID,

          dbo.FN_Get_OrganizationShortName(
            org.OrganizationID
          ) AS Hotel,

          COUNT(EM.ID) AS Total

        FROM dbo.htl_tbl_organization_master AS org

        LEFT JOIN CheckList.Chk_Tbl_CheckList_Entry_Master AS EM
          ON EM.OrganizationID = org.OrganizationID
          AND EM.EntryDate >= @FromDate
          AND EM.EntryDate < DATEADD(DAY, 1, @ToDate)

        WHERE org.Activation_status = 1
          AND org.IsNileHotel = 1

          AND (
            @OrganizationID IS NULL
            OR org.OrganizationID = @OrganizationID
          )

        GROUP BY org.OrganizationID

        ORDER BY Hotel;
      `);

    // ========================================================
    // 5. Response Mapping
    // ========================================================

    const chartData = result.recordset.map((row) => ({
      OrganizationID: Number(row.OrganizationID),
      Hotel: row.Hotel || null,
      Total: Number(row.Total || 0),
    }));

    // ========================================================
    // 6. Response
    // ========================================================

    return ok(
      "CEO checklist fetched successfully.",
      chartData,
      {
        Filter: filter,
        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalOrganizations: chartData.length,

        TotalCheckLists: chartData.reduce(
          (sum, row) => sum + row.Total,
          0
        ),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO checklist"
    );
  }
};
// 18. ============================================================ Discards Trend
const getCEODiscard = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range (Existing Helper)
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 5. MSSQL Query - TOTAL DISCARD COST
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "FromDate",
        sql.Date,
        dates.CurrentFromDate
      )
      .input(
        "ToDate",
        sql.Date,
        dates.CurrentToDate
      )
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .query(`
        SELECT
          org.OrganizationID,

          dbo.FN_Get_OrganizationShortName(
            org.OrganizationID
          ) AS Hotel,

          ISNULL(d.Total, 0) AS Total

        FROM dbo.htl_tbl_organization_master AS org

        LEFT JOIN
        (
          SELECT
            e.OrganizationID,

            SUM(
              ISNULL(c.TotalCost, 0)
            ) AS Total

          FROM Discard.Discard_Tbl_Entry_Master AS e

          INNER JOIN Discard.Discard_Tbl_Entry_Item_Details AS c
            ON e.DiscardID = c.DiscardID

          WHERE e.DiscardDate >= @FromDate
            AND e.DiscardDate < DATEADD(DAY, 1, @ToDate)

          GROUP BY e.OrganizationID

        ) AS d
          ON org.OrganizationID = d.OrganizationID

        WHERE org.Activation_status = 1
          AND org.IsNileHotel = 1
          AND org.OrganizationID <> 3

          AND (
            @OrganizationID IS NULL
            OR org.OrganizationID = @OrganizationID
          )

        ORDER BY Hotel;
      `);

    // ========================================================
    // 6. Response Mapping
    // ========================================================

    const chartData = result.recordset.map((row) => ({
      OrganizationID: Number(row.OrganizationID),

      Hotel: row.Hotel || null,

      Total: Number(row.Total ?? 0),
    }));

    // ========================================================
    // 7. Total Discard Cost
    // ========================================================

    const totalDiscardCost = chartData.reduce(
      (sum, row) => sum + row.Total,
      0
    );

    // ========================================================
    // 8. Response
    // ========================================================

    return ok(
      "CEO discard chart fetched successfully.",
      chartData,
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalOrganizations: chartData.length,

        TotalDiscardCost: totalDiscardCost,
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO discard"
    );
  }
};
// 18.1 ============================================================ Discards Details
const getCEODiscardDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Pagination Validation
    // ========================================================

    const page = Number(data.page ?? 1);
    const pageSize = Number(data.PageSize ?? 10);

    if (
      !Number.isSafeInteger(page) ||
      page <= 0 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      return fail(
        "Invalid page or PageSize.",
        400
      );
    }

    const offset = (page - 1) * pageSize;

    if (
      !Number.isSafeInteger(offset) ||
      offset > 2147483647 - pageSize
    ) {
      return fail(
        "Pagination offset is too large.",
        400
      );
    }

    // ========================================================
    // 4. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 5. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 6. MSSQL Dynamic Query
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .input(
        "FromDate",
        sql.Date,
        dates.CurrentFromDate
      )
      .input(
        "ToDate",
        sql.Date,
        dates.CurrentToDate
      )
      .input("Offset", sql.Int, offset)
      .input("Limit", sql.Int, pageSize)
      .query(`
        DECLARE @DetailColumns NVARCHAR(MAX);
        DECLARE @TotalColumns NVARCHAR(MAX);
        DECLARE @SQL NVARCHAR(MAX);

        -- ====================================================
        -- ALL ITEM DETAIL COLUMNS
        -- ====================================================

        SELECT
          @DetailColumns = STRING_AGG(
            CAST(
              'c.' + QUOTENAME(name) +
              CASE
                WHEN name IN (
                  'SrNo',
                  'OrganizationID',
                  'Hotel',
                  'DiscardID',
                  'DiscardDate'
                )
                THEN ' AS ' +
                  QUOTENAME('Detail_' + name)
                ELSE ''
              END
              AS NVARCHAR(MAX)
            ),
            ', '
          ) WITHIN GROUP (ORDER BY column_id),

          @TotalColumns = STRING_AGG(
            CAST(
              CASE
                WHEN name = 'TotalCost'
                THEN
                  'SUM(ISNULL(' +
                  QUOTENAME(name) +
                  ', 0))'
                ELSE 'NULL'
              END
              AS NVARCHAR(MAX)
            ),
            ', '
          ) WITHIN GROUP (ORDER BY column_id)

        FROM sys.columns

        WHERE object_id = OBJECT_ID(
          'Discard.Discard_Tbl_Entry_Item_Details'
        );

        IF @DetailColumns IS NULL
        BEGIN
          THROW 50001,
            'Discard item details columns not found.',
            1;
        END;

        -- ====================================================
        -- DYNAMIC DETAILS + GRAND TOTAL
        -- ====================================================

        SET @SQL = N'
          ;WITH DiscardData AS
          (
            SELECT
              ROW_NUMBER() OVER (
                ORDER BY
                  e.DiscardDate DESC,
                  e.DiscardID DESC
              ) AS SrNo,

              e.OrganizationID,

              dbo.FN_Get_OrganizationShortName(
                e.OrganizationID
              ) AS Hotel,

              e.DiscardID,

              e.DiscardDate AS DiscardDate,

              ' + @DetailColumns + ',

              COUNT(*) OVER() AS __TotalCount

            FROM Discard.Discard_Tbl_Entry_Master AS e

            INNER JOIN Discard.Discard_Tbl_Entry_Item_Details AS c
              ON e.DiscardID = c.DiscardID

            INNER JOIN dbo.htl_tbl_organization_master AS org
              ON e.OrganizationID = org.OrganizationID

            WHERE org.Activation_status = 1
              AND org.IsNileHotel = 1
              AND org.OrganizationID <> 3

              AND (
                @OrganizationID IS NULL
                OR e.OrganizationID = @OrganizationID
              )

              AND e.DiscardDate >= @FromDate
              AND e.DiscardDate <
                DATEADD(DAY, 1, @ToDate)
          ),

          -- ================================================
          -- PAGINATED DETAILS
          -- ================================================

          PagedData AS
          (
            SELECT *
            FROM DiscardData

            WHERE SrNo > @Offset
              AND SrNo <= @Offset + @Limit
          ),

          -- ================================================
          -- DETAILS + GRAND TOTAL
          -- ================================================

          FinalResult AS
          (
            SELECT
              0 AS SortOrder,
              *
            FROM PagedData

            UNION ALL

            SELECT
              1 AS SortOrder,

              NULL AS SrNo,
              NULL AS OrganizationID,
              ''TOTAL'' AS Hotel,
              NULL AS DiscardID,
              NULL AS DiscardDate,

              ' + @TotalColumns + ',

              COUNT(*) AS __TotalCount

            FROM DiscardData
          )

          SELECT *
          FROM FinalResult

          ORDER BY
            SortOrder,
            SrNo;
        ';

        EXEC sys.sp_executesql
          @SQL,
          N'@OrganizationID BIGINT,
            @FromDate DATE,
            @ToDate DATE,
            @Offset INT,
            @Limit INT',
          @OrganizationID = @OrganizationID,
          @FromDate = @FromDate,
          @ToDate = @ToDate,
          @Offset = @Offset,
          @Limit = @Limit;
      `);

    // ========================================================
    // 7. Separate Detail and Total Rows
    // ========================================================

    const rows = result.recordset || [];

    const detailRows = rows.filter(
      (row) => Number(row.SortOrder) === 0
    );

    const totalRow = rows.find(
      (row) => Number(row.SortOrder) === 1
    );

    // ========================================================
    // 8. Total Count
    // ========================================================

    const totalCount = Number(
      totalRow?.__TotalCount ?? 0
    );

    // ========================================================
    // 9. Response Mapping
    // ========================================================

    const discardDetails = detailRows.map((row) => {
      const {
        SortOrder,
        __TotalCount,
        CreatedBy,
        ModifyBy,
        ModifyDateTime,
        Detail_DiscardID,
        Detail_OrganizationID,
        Detail_SrNo,
        Detail_Hotel,
        Detail_DiscardDate,
        ...details
      } = row;

      for (const key of Object.keys(details)) {
        if (/date(time)?$/i.test(key)) {
          details[key] = formatDate(details[key]);
        }
      }

      return {
        ...details,

        SrNo: Number(row.SrNo),

        OrganizationID:
          row.OrganizationID == null
            ? null
            : String(row.OrganizationID),

        TotalCost:
          row.TotalCost == null
            ? 0
            : Number(row.TotalCost),
      };
    });

    // ========================================================
    // 10. Grand Total
    // ========================================================

    const grandTotal = {
      Hotel: "TOTAL",

      TotalCost: Number(
        totalRow?.TotalCost ?? 0
      ),
    };

    // ========================================================
    // 11. Response
    // ========================================================

    return ok(
      "CEO discard details fetched successfully.",
      {
        DiscardDetails: discardDetails,
        GrandTotal: grandTotal,
      },
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalCount: totalCount,

        page: page,
        PageSize: pageSize,

        TotalPages: Math.ceil(
          totalCount / pageSize
        ),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO discard details"
    );
  }
};
// 19. ============================================================ Lost and Found Trend
const getCEOLostAndFound = async (data) => {
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
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range (Existing Helper)
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. MSSQL Query
    // ========================================================

    const mssqlPool = await getMssqlPool();

    const result = await mssqlPool
      .request()
      .input("FromDate", sql.Date, dates.CurrentFromDate)
      .input("ToDate", sql.Date, dates.CurrentToDate)
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .query(`
        SELECT
          org.OrganizationID,

          dbo.FN_Get_OrganizationShortName(
            org.OrganizationID
          ) AS Hotel,

          ISNULL(
            SUM(
              ISNULL(
                TRY_CAST(lf.Qty AS DECIMAL),
                0
              )
            ),
            0
          ) AS Total

        FROM dbo.htl_tbl_organization_master AS org

        LEFT JOIN LostNFound.LostNFound_Tbl_Entry_Master AS lf
          ON lf.OrganizationID = org.OrganizationID
          AND lf.Datefoundon >= @FromDate
          AND lf.Datefoundon < DATEADD(DAY, 1, @ToDate)

        WHERE org.Activation_status = 1
          AND org.IsNileHotel = 1
          AND org.OrganizationID <> 3

          AND (
            @OrganizationID IS NULL
            OR org.OrganizationID = @OrganizationID
          )

        GROUP BY org.OrganizationID

        ORDER BY Hotel ASC;
      `);

    // ========================================================
    // 5. Response Mapping
    // ========================================================

    const chartData = result.recordset.map((row) => ({
      OrganizationID: Number(row.OrganizationID),
      Hotel: row.Hotel || null,
      Total: Number(row.Total || 0),
    }));

    // ========================================================
    // 6. Response
    // ========================================================

    return ok(
      "CEO lost and found data fetched successfully.",
      chartData,
      {
        Filter: filter,
        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalOrganizations: chartData.length,

        TotalLostAndFound: chartData.reduce(
          (sum, row) => sum + row.Total,
          0
        ),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO lost and found"
    );
  }
};
// 19.1 ============================================================ Lost and Found Details
const getCEOLostAndFoundDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Pagination Validation
    // ========================================================

    const page = Number(data.page ?? 1);
    const pageSize = Number(data.PageSize ?? 10);

    if (
      !Number.isSafeInteger(page) ||
      page <= 0 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      return fail("Invalid page or PageSize.", 400);
    }

    const offset = (page - 1) * pageSize;

    if (
      !Number.isSafeInteger(offset) ||
      offset > 2147483647
    ) {
      return fail(
        "Pagination offset is too large.",
        400
      );
    }

    // ========================================================
    // 4. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 5. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 6. MSSQL Query
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .input(
        "FromDate",
        sql.Date,
        dates.CurrentFromDate
      )
      .input(
        "ToDate",
        sql.Date,
        dates.CurrentToDate
      )
      .input("Offset", sql.Int, offset)
      .input("PageSize", sql.Int, pageSize)
      .query(`
        ;WITH LostFoundData AS
        (
          SELECT
            e.OrganizationID,

            dbo.FN_Get_OrganizationShortName(
              e.OrganizationID
            ) AS Hotel,

            e.Datefoundon,
            e.RoomNumber,
            e.GuestName,
            e.MobileNo,
            e.EmailID,
            e.ArrivalDate,
            e.DepartureDate,
            e.ItemType,
            e.ItemDescription,
            e.Qty,
            e.DisposedOn,
            e.DisposedBy,
            e.DrainedBy,
            e.DrainedOn,
            e.FoundBy,
            e.GatepassNo,
            e.Status,
            e.HandedOverEmpName,
            e.HandedOvertoGuest,
            e.CourieredtoGuestName,
            e.CourieredToGuestTrackingID,
            e.CourieredToGuestOn,
            e.Status_HandedEmployeeOn,
            e.Status_HandedGuestOn,
            e.IsSendSMStoGuest,
            e.IsSendEmailtoGuest,
            e.HOD_A_Status,
            e.GM_A_Status,
            e.Category

          FROM LostNFound.LostNFound_Tbl_Entry_Master AS e

          WHERE (
            @OrganizationID IS NULL
            OR e.OrganizationID = @OrganizationID
          )

            AND e.Datefoundon >= @FromDate
            AND e.Datefoundon < DATEADD(DAY, 1, @ToDate)
        ),

        NumberedData AS
        (
          SELECT
            ROW_NUMBER() OVER (
              ORDER BY Datefoundon DESC, OrganizationID
            ) AS SrNo,

            *

          FROM LostFoundData
        ),

        PagedData AS
        (
          SELECT *
          FROM NumberedData

          WHERE SrNo > @Offset
            AND SrNo <= @Offset + @PageSize
        )

        -- ====================================================
        -- RESULT SET 1: PAGINATED DETAILS
        -- ====================================================

        SELECT
          SrNo,
          OrganizationID,
          Hotel,

          CONVERT(
            VARCHAR(11),
            Datefoundon,
            106
          ) AS DateFound,

          RoomNumber,
          GuestName,
          MobileNo,
          EmailID,

          CONVERT(
            VARCHAR(11),
            ArrivalDate,
            106
          ) AS ArrivalDate,

          CONVERT(
            VARCHAR(11),
            DepartureDate,
            106
          ) AS DepartureDate,

          ItemType,
          ItemDescription,

          ISNULL(
            TRY_CAST(Qty AS DECIMAL(18, 2)),
            0
          ) AS Qty,

          CONVERT(
            VARCHAR(11),
            DisposedOn,
            106
          ) AS DisposedOn,

          DisposedBy,
          DrainedBy,

          CONVERT(
            VARCHAR(11),
            DrainedOn,
            106
          ) AS DrainedOn,

          FoundBy,
          GatepassNo,
          Status,
          HandedOverEmpName,
          HandedOvertoGuest,
          CourieredtoGuestName,
          CourieredToGuestTrackingID,
          CourieredToGuestOn,
          Status_HandedEmployeeOn,
          Status_HandedGuestOn,
          IsSendSMStoGuest,
          IsSendEmailtoGuest,
          HOD_A_Status,
          GM_A_Status,
          Category

        FROM PagedData

        ORDER BY SrNo;

        -- ====================================================
        -- RESULT SET 2: TOTAL COUNT AND GRAND TOTAL
        -- ====================================================

        SELECT
          COUNT(*) AS TotalCount,

          SUM(
            ISNULL(
              TRY_CAST(e.Qty AS DECIMAL(18, 2)),
              0
            )
          ) AS TotalQty

        FROM LostNFound.LostNFound_Tbl_Entry_Master AS e

        WHERE (
          @OrganizationID IS NULL
          OR e.OrganizationID = @OrganizationID
        )

          AND e.Datefoundon >= @FromDate
          AND e.Datefoundon < DATEADD(DAY, 1, @ToDate);
      `);

    // ========================================================
    // 7. Pagination And Grand Total
    // ========================================================

    const rows = result.recordsets?.[0] ?? [];

    const summary = result.recordsets?.[1]?.[0] ?? {};

    const totalCount = Number(
      summary.TotalCount ?? 0
    );

    const grandTotalQty = Number(
      summary.TotalQty ?? 0
    );

    // ========================================================
    // 8. Response Mapping
    // ========================================================

    const lostAndFoundDetails = rows.map((row) => ({
      SrNo: Number(row.SrNo),

      OrganizationID:
        row.OrganizationID == null
          ? null
          : String(row.OrganizationID),

      Hotel: row.Hotel ?? null,

      DateFound: row.DateFound ?? null,

      RoomNumber: row.RoomNumber ?? null,

      GuestName: row.GuestName ?? null,

      MobileNo: row.MobileNo ?? null,

      EmailID: row.EmailID ?? null,

      ArrivalDate: row.ArrivalDate ?? null,

      DepartureDate: row.DepartureDate ?? null,

      ItemType: row.ItemType ?? null,

      ItemDescription: row.ItemDescription ?? null,

      Qty: Number(row.Qty ?? 0),

      DisposedOn: row.DisposedOn ?? null,

      DisposedBy: row.DisposedBy ?? null,

      DrainedBy: row.DrainedBy ?? null,

      DrainedOn: row.DrainedOn ?? null,

      FoundBy: row.FoundBy ?? null,

      GatepassNo: row.GatepassNo ?? null,

      Status: row.Status ?? null,

      HandedOverEmpName:
        row.HandedOverEmpName ?? null,

      HandedOvertoGuest:
        row.HandedOvertoGuest ?? null,

      CourieredtoGuestName:
        row.CourieredtoGuestName ?? null,

      CourieredToGuestTrackingID:
        row.CourieredToGuestTrackingID ?? null,

      CourieredToGuestOn:
        row.CourieredToGuestOn ?? null,

      Status_HandedEmployeeOn:
        row.Status_HandedEmployeeOn ?? null,

      Status_HandedGuestOn:
        row.Status_HandedGuestOn ?? null,

      IsSendSMStoGuest:
        row.IsSendSMStoGuest ?? null,

      IsSendEmailtoGuest:
        row.IsSendEmailtoGuest ?? null,

      HOD_A_Status:
        row.HOD_A_Status ?? null,

      GM_A_Status:
        row.GM_A_Status ?? null,

      Category: row.Category ?? null,
    }));

    // ========================================================
    // 9. Response
    // ========================================================

    return ok(
      "CEO lost and found details fetched successfully.",
      {
        LostAndFoundDetails: lostAndFoundDetails,

        GrandTotal: {
          GuestName: "TOTAL",
          Qty: grandTotalQty,
        },
      },
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalCount: totalCount,

        page: page,

        PageSize: pageSize,

        TotalPages: Math.ceil(
          totalCount / pageSize
        ),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO lost and found details"
    );
  }
};
// 20. ============================================================ Operational Health
const getCEOOperationalHealth = async (data) => {
  try {
    const rawOrganizationID = data.OrganizationID;
    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      ((typeof rawOrganizationID !== "string" && typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n)
    ) {
      return fail("OrganizationID must be a positive integer.", 400);
    }

    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. Date Range (Existing Helper)
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 3. PostgreSQL Query
    // ========================================================

    const result = await pool.query(
      `
        SELECT
          (
            SELECT COUNT(*)::BIGINT
            FROM guest_glitch_entry_master
            WHERE IsDeleted = FALSE
              AND UPPER(TRIM(Status)) = 'OPEN'
              AND EntryDate >= $1::DATE
              AND EntryDate <= $2::DATE
              AND ($3::BIGINT IS NULL OR OrganizationID = $3::BIGINT)
          ) AS TotalGlitches,

          (
            SELECT COUNT(*)::BIGINT
            FROM incident_report_entry_master
            WHERE IsDeleted = FALSE
              AND IncidentDate >= $1::DATE
              AND IncidentDate <= $2::DATE
              AND ($3::BIGINT IS NULL OR OrganizationID = $3::BIGINT)
          ) AS TotalIncidents;
      `,
      [
        dates.CurrentFromDate,
        dates.CurrentToDate,
        organizationID || null,
      ]
    );

    // ========================================================
    // 4. Response
    // ========================================================

    return ok(
      "CEO operational health fetched successfully.",
      {
        Filter: filter,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalGlitches: Number(
          result.rows[0].totalglitches
        ),

        TotalIncidents: Number(
          result.rows[0].totalincidents
        ),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO operational health"
    );
  }
};
// 20.1. ============================================================ Operational Health Gltch
const getCEOOperationalGlitchDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================
    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (!["yesterday", "weekly", "monthly", "yearly"].includes(filter)) {
      return fail("Invalid date filter.", 400);
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================
    const rawOrganizationID = data.OrganizationID;
    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail("OrganizationID must be a positive integer.", 400);
    }

    // ========================================================
    // 3. Pagination Validation
    // ========================================================
    const page = Number(data.page ?? 1);
    const pageSize = Number(data.PageSize ?? 10);

    if (!Number.isSafeInteger(page) || page <= 0) {
      return fail("Page must be a positive integer.", 400);
    }

    if (
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      return fail("PageSize must be between 1 and 100.", 400);
    }

    const offset = (page - 1) * pageSize;

    // ========================================================
    // 4. Date Range
    // ========================================================
    const dates = getDateRange(filter);

    // ========================================================
    // 5. PostgreSQL Query
    // ========================================================
    const result = await pool.query(
      `
      SELECT
        g.ID,
        g.OrganizationID,
        o.ShortName AS OrganizationShortName,
        g.EntryDate,
        g.Time,
        g.GuestName,
        g.CompanyName,
        g.RoomNumber,
        g.Complaint,
        g.ServiceRecovery,
        g.ProcessLapse,
        g.ProcessLapseCategory,
        g.GMComment,
        g.Department,
        g.DetailedInvestigation,
        g.InternalActionTaken,
        g.ResolvedBy,
        g.Status,
        g.CreatedDate,

        COUNT(*) OVER()::BIGINT AS TotalCount

      FROM guest_glitch_entry_master g

      LEFT JOIN organization_master o
        ON o.OrganizationID = g.OrganizationID

      WHERE g.IsDeleted = FALSE
        AND UPPER(TRIM(g.Status)) = 'OPEN'
        AND g.EntryDate >= $1::DATE
        AND g.EntryDate <= $2::DATE
        AND (
          $3::BIGINT IS NULL
          OR g.OrganizationID = $3::BIGINT
        )

      ORDER BY
        g.EntryDate DESC NULLS LAST,
        g.CreatedDate DESC,
        g.ID DESC

      LIMIT $4 OFFSET $5;
      `,
      [
        dates.CurrentFromDate,
        dates.CurrentToDate,
        organizationID || null,
        pageSize,
        offset,
      ]
    );

    // ========================================================
    // 6. Count (also works when requested page is empty)
    // ========================================================
    let totalCount = Number(result.rows[0]?.totalcount || 0);

    if (!result.rows.length) {
      const countResult = await pool.query(
        `
        SELECT COUNT(*)::BIGINT AS TotalCount
        FROM guest_glitch_entry_master g
        WHERE g.IsDeleted = FALSE
          AND UPPER(TRIM(g.Status)) = 'OPEN'
          AND g.EntryDate >= $1::DATE
          AND g.EntryDate <= $2::DATE
          AND (
            $3::BIGINT IS NULL
            OR g.OrganizationID = $3::BIGINT
          );
        `,
        [
          dates.CurrentFromDate,
          dates.CurrentToDate,
          organizationID || null,
        ]
      );

      totalCount = Number(countResult.rows[0].totalcount);
    }

    // ========================================================
    // 7. Response Mapping
    // ========================================================
    const glitchDetails = result.rows.map((row) => ({
      ID: Number(row.id),
      OrganizationID: row.organizationid == null
        ? null
        : Number(row.organizationid),
      OrganizationShortName: row.organizationshortname ?? null,
      GuestName: row.guestname ?? null,
      CompanyName: row.companyname ?? null,
      RoomNumber: row.roomnumber ?? null,
      Complaint: row.complaint ?? null,
      ServiceRecovery: row.servicerecovery ?? null,
      ProcessLapse: row.processlapse ?? null,
      ProcessLapseCategory: row.processlapsecategory ?? null,
      GMComment: row.gmcomment ?? null,
      Department: row.department ?? null,
      DetailedInvestigation: row.detailedinvestigation ?? null,
      InternalActionTaken: row.internalactiontaken ?? null,
      ResolvedBy: row.resolvedby ?? null,
      Status: row.status,
      Priority: "High",
      EntryDate: formatDate(row.entrydate),
      Time: row.time ?? null,
      CreatedDate: formatDate(row.createddate),
    }));

    // ========================================================
    // 8. Response
    // ========================================================
    return ok(
      "CEO operational glitch details fetched successfully.",
      glitchDetails,
      {
        Filter: filter,
        OrganizationID: organizationID || null,
        DateRange: {
          FromDate: formatDate(dates.CurrentFromDate),
          ToDate: formatDate(dates.CurrentToDate),
        },
        TotalCount: totalCount,
        page,
        PageSize: pageSize,
        TotalPages: Math.ceil(totalCount / pageSize),
      }
    );

  } catch (error) {
    return databaseFailure(error, "Fetch CEO operational glitch details");
  }
};
// 20.2. ============================================================ Operational Health Incident
const getCEOOperationalIncidentDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================
    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (!["yesterday", "weekly", "monthly", "yearly"].includes(filter)) {
      return fail("Invalid date filter.", 400);
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================
    const rawOrganizationID = data.OrganizationID;
    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail("OrganizationID must be a positive integer.", 400);
    }

    // ========================================================
    // 3. Pagination Validation
    // ========================================================
    const page = Number(data.page ?? 1);
    const pageSize = Number(data.PageSize ?? 10);

    if (!Number.isSafeInteger(page) || page <= 0) {
      return fail("Page must be a positive integer.", 400);
    }

    if (
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      return fail("PageSize must be between 1 and 100.", 400);
    }

    const offset = (page - 1) * pageSize;

    // ========================================================
    // 4. Date Range
    // ========================================================
    const dates = getDateRange(filter);

    // ========================================================
    // 5. PostgreSQL Query
    // ========================================================
    const result = await pool.query(
      `
      SELECT
        i.ID,
        i.OrganizationID,
        o.ShortName AS OrganizationShortName,
        i.ReportDate,
        i.IncidentDate,
        i.Time,
        i.Location,
        i.AccidentCause,
        i.AnyCasualty,
        i.Description,
        i.DamagedCaused,
        i.Investigation,
        i.InvestigatedBy,
        i.PresentDuringIncident,
        i.ReportTo,
        i.ReportBy,
        i.CreatedDate,

        COUNT(*) OVER()::BIGINT AS TotalCount

      FROM incident_report_entry_master i

      LEFT JOIN organization_master o
        ON o.OrganizationID = i.OrganizationID

      WHERE i.IsDeleted = FALSE
        AND i.IncidentDate >= $1::DATE
        AND i.IncidentDate <= $2::DATE
        AND (
          $3::BIGINT IS NULL
          OR i.OrganizationID = $3::BIGINT
        )

      ORDER BY
        i.IncidentDate DESC,
        i.CreatedDate DESC NULLS LAST,
        i.ID DESC

      LIMIT $4 OFFSET $5;
      `,
      [
        dates.CurrentFromDate,
        dates.CurrentToDate,
        organizationID || null,
        pageSize,
        offset,
      ]
    );

    // ========================================================
    // 6. Total Count
    // ========================================================
    let totalCount = Number(result.rows[0]?.totalcount || 0);

    if (!result.rows.length) {
      const countResult = await pool.query(
        `
        SELECT COUNT(*)::BIGINT AS TotalCount
        FROM incident_report_entry_master i
        WHERE i.IsDeleted = FALSE
          AND i.IncidentDate >= $1::DATE
          AND i.IncidentDate <= $2::DATE
          AND (
            $3::BIGINT IS NULL
            OR i.OrganizationID = $3::BIGINT
          );
        `,
        [
          dates.CurrentFromDate,
          dates.CurrentToDate,
          organizationID || null,
        ]
      );

      totalCount = Number(countResult.rows[0].totalcount);
    }

    // ========================================================
    // 7. Response Mapping
    // ========================================================
    const incidentDetails = result.rows.map((row) => ({
      ID: row.id,
      OrganizationID: Number(row.organizationid),
      OrganizationShortName: row.organizationshortname ?? null,

      ReportDate: formatDate(row.reportdate),

      IncidentDate: formatDate(row.incidentdate),

      Time: row.time ?? null,
      Location: row.location ?? null,
      AccidentCause: row.accidentcause ?? null,
      AnyCasualty: row.anycasualty ?? null,
      Description: row.description ?? null,
      DamagedCaused: row.damagedcaused ?? null,
      Investigation: row.investigation ?? null,
      InvestigatedBy: row.investigatedby ?? null,
      PresentDuringIncident: row.presentduringincident ?? null,
      ReportTo: row.reportto ?? null,
      ReportBy: row.reportby ?? null,
      CreatedDate: formatDate(row.createddate),
    }));

    // ========================================================
    // 8. Response
    // ========================================================
    return ok(
      "CEO operational incident details fetched successfully.",
      incidentDetails,
      {
        Filter: filter,
        OrganizationID: organizationID || null,
        DateRange: {
          FromDate: formatDate(dates.CurrentFromDate),
          ToDate: formatDate(dates.CurrentToDate),
        },
        TotalCount: totalCount,
        page,
        PageSize: pageSize,
        TotalPages: Math.ceil(totalCount / pageSize),
      }
    );

  } catch (error) {
    return databaseFailure(error, "Fetch CEO operational incident details");
  }
};
// 21. ============================================================ Forecast Occupancy Trend
const getCEOForecastOccupancy = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "tomorrow")
      .trim()
      .toLowerCase();

    if (
      !["tomorrow", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be tomorrow, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Forecast Date Range (India Timezone)
    // ========================================================

    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());

    const values = {};

    parts.forEach(({ type, value }) => {
      if (type !== "literal") {
        values[type] = Number(value);
      }
    });

    const year = values.year;
    const month = values.month;
    const day = values.day;

    const today = new Date(
      Date.UTC(year, month - 1, day)
    );

    const tomorrow = new Date(today);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);

    let fromDate = new Date(tomorrow);
    let toDate = new Date(tomorrow);

    // ========================================================
    // 4. Filter Wise Date Range (Same as Forecast ADR)
    // ========================================================

    switch (filter) {
      case "tomorrow":
        break;

      case "weekly": {
        // Current calendar week: Monday through Sunday.
        const daysSinceMonday =
          (today.getUTCDay() + 6) % 7;

        fromDate = new Date(today);
        fromDate.setUTCDate(
          fromDate.getUTCDate() - daysSinceMonday
        );

        toDate = new Date(fromDate);
        toDate.setUTCDate(
          toDate.getUTCDate() + 6
        );

        break;
      }

      case "monthly":
        fromDate = new Date(
          Date.UTC(year, month - 1, 1)
        );

        toDate = new Date(
          Date.UTC(year, month, 0)
        );

        break;

      case "yearly":
        fromDate = new Date(
          Date.UTC(year, 0, 1)
        );

        toDate = new Date(
          Date.UTC(year, 11, 31)
        );

        break;
    }

    const fromDateString =
      fromDate.toISOString().slice(0, 10);

    const toDateString =
      toDate.toISOString().slice(0, 10);

    // ========================================================
    // 5. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 6. MSSQL Query
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .input(
        "FromDate",
        sql.Date,
        fromDateString
      )
      .input(
        "ToDate",
        sql.Date,
        toDateString
      )
      .query(`
        SELECT
          org.OrganizationID,

          org.ShortDisplayLabel AS Hotel,

          ISNULL(
            AVG(
              TRY_CAST(
                ISNULL(f.Occ_Forecast_Percentage, 0)
                AS DECIMAL(18, 2)
              )
            ),
            0
          ) AS Occupancy

        FROM dbo.htl_tbl_organization_master AS org

        LEFT JOIN PMSData.PMSData_IDS_Forecast_Report_Master AS f
          ON org.OrganizationID = f.OrganizationID
          AND f.[DATE] >= @FromDate
          AND f.[DATE] < DATEADD(DAY, 1, @ToDate)
          AND f.IsDeleted = 0

        WHERE org.Activation_status = 1
          AND org.IsNileHotel = 1
          AND (
            @OrganizationID IS NULL
            OR org.OrganizationID = @OrganizationID
          )

        GROUP BY
          org.OrganizationID,
          org.ShortDisplayLabel

        ORDER BY
          org.ShortDisplayLabel;
      `);

    // ========================================================
    // 7. Response Mapping
    // ========================================================

    const chartData = result.recordset.map((row) => ({
      OrganizationID: Number(row.OrganizationID),
      Hotel: row.Hotel ?? null,
      Occupancy: Number(row.Occupancy ?? 0),
      occupancypercentage: `${Math.round(Number(row.Occupancy ?? 0))}%`,
    }));

    // ========================================================
    // 8. Response
    // ========================================================

    return ok(
      "CEO forecast occupancy fetched successfully.",
      chartData,
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: fromDateString,
          ToDate: toDateString,
        },

        TotalOrganizations: chartData.length,
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO forecast occupancy"
    );
  }
};
// 22. ============================================================ Engineering Count
const getCEOEngineeringSummary = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range (Existing Helper)
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. PostgreSQL Query
    // ========================================================

    const result = await pool.query(
      `
        WITH equipment AS
        (
          SELECT *
          FROM engineering_equipment_entry_master

          WHERE IsDeleted = FALSE

            AND (
              $3::BIGINT IS NULL
              OR OrganizationID = $3::BIGINT
            )

            AND CreatedDate >= $1::DATE
            AND CreatedDate < ($2::DATE + INTERVAL '1 day')
        ),

        maintenance AS
        (
          SELECT m.*
          FROM engineering_maintenance_details m

          WHERE m.IsDeleted = FALSE

            AND (
              $3::BIGINT IS NULL
              OR m.OrganizationID = $3::BIGINT
            )

            AND m.MaintenanceDate >= $1::DATE
            AND m.MaintenanceDate < ($2::DATE + INTERVAL '1 day')
        ),

        scheduled_without_entry AS
        (
          SELECT e.EquipmentID
          FROM equipment e

          WHERE NULLIF(
            TRIM(e.ScheduleOfServicing),
            ''
          ) IS NOT NULL

          AND NOT EXISTS
          (
            SELECT 1
            FROM maintenance m
            WHERE m.EquipmentID = e.EquipmentID
          )
        ),

        breakdowns AS
        (
          SELECT *
          FROM engineering_breakdown_entry

          WHERE IsDeleted = FALSE

            AND (
              $3::BIGINT IS NULL
              OR OrganizationID = $3::BIGINT
            )

            AND CreatedDate >= $1::DATE
            AND CreatedDate < ($2::DATE + INTERVAL '1 day')
        )

        SELECT

          -- ==================================================
          -- 1. TOTAL EQUIPMENTS
          -- ==================================================
          (
            SELECT COUNT(*)
            FROM equipment
          ) AS "TotalEquipments",

          -- ==================================================
          -- 2. UNDER WARRANTY
          -- ==================================================
          (
            SELECT COUNT(*)
            FROM equipment
            WHERE WarrantyStatus = 'Under Warranty'
          ) AS "UnderWarranty",

          -- ==================================================
          -- 3. UNDER AMC
          -- ==================================================
          (
            SELECT COUNT(*)
            FROM equipment
            WHERE AMCStatus = 'Under AMC'
          ) AS "UnderAMC",

          -- ==================================================
          -- 4. OTHER EQUIPMENTS
          -- Neither Under Warranty nor Under AMC
          -- ==================================================
          (
            SELECT COUNT(*)
            FROM equipment
            WHERE (
              WarrantyStatus IS NULL
              OR TRIM(WarrantyStatus) <> 'Under Warranty'
            )
            AND (
              AMCStatus IS NULL
              OR TRIM(AMCStatus) <> 'Under AMC'
            )
          ) AS "OtherEquipments",

          -- ==================================================
          -- 5. TOTAL BREAKDOWN
          -- ==================================================
          (
            SELECT COUNT(*)
            FROM breakdowns
          ) AS "TotalBreakdown",

          -- ==================================================
          -- 6. TOTAL MAINTENANCE
          -- Maintenance + Scheduled Without Entry
          -- ==================================================
          (
            (SELECT COUNT(*) FROM maintenance)
            +
            (SELECT COUNT(*) FROM scheduled_without_entry)
          ) AS "TotalMaintenance",

          -- ==================================================
          -- 7. PENDING MAINTENANCE
          -- ONLY engineering_maintenance_details
          -- ==================================================
          (
            SELECT COUNT(*)
            FROM maintenance
            WHERE LOWER(TRIM(Status)) = 'pending'
          ) AS "PendingMaintenance";
      `,
      [
        dates.CurrentFromDate,
        dates.CurrentToDate,
        organizationID || null,
      ]
    );

    // ========================================================
    // 5. Response Mapping
    // ========================================================

    const row = result.rows[0];

    const summary = {
      TotalEquipments: Number(row.TotalEquipments ?? 0),

      UnderWarranty: Number(row.UnderWarranty ?? 0),

      UnderAMC: Number(row.UnderAMC ?? 0),

      OtherEquipments: Number(row.OtherEquipments ?? 0),

      TotalBreakdown: Number(row.TotalBreakdown ?? 0),

      TotalMaintenance: Number(row.TotalMaintenance ?? 0),

      PendingMaintenance: Number(row.PendingMaintenance ?? 0),
    };

    // ========================================================
    // 6. Response
    // ========================================================

    return ok(
      "CEO engineering summary fetched successfully.",
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        ...summary,
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO engineering summary"
    );
  }
};
// 22.1. ============================================================ Engineering Total Equipments Details
const getCEOEquipmentDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Pagination Validation
    // ========================================================

    const page = Number(data.page ?? 1);
    const pageSize = Number(data.PageSize ?? 10);

    if (
      !Number.isSafeInteger(page) ||
      page <= 0 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      return fail("Invalid page or PageSize.", 400);
    }

    const offset = (page - 1) * pageSize;

    if (
      !Number.isSafeInteger(offset) ||
      offset > 2147483647
    ) {
      return fail("Pagination offset is too large.", 400);
    }

    // ========================================================
    // 4. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 5. PostgreSQL Query
    // ========================================================

    const result = await pool.query(
      `
        SELECT
          e.*,
          org.ShortName AS "OrganizationShortName",

          COUNT(*) OVER()::BIGINT AS "TotalCount"

        FROM engineering_equipment_entry_master e
        LEFT JOIN Organization_Master org
          ON org.OrganizationID = e.OrganizationID

        WHERE e.IsDeleted = FALSE

          AND (
            $3::BIGINT IS NULL
            OR e.OrganizationID = $3::BIGINT
          )

          AND e.CreatedDate >= $1::DATE
          AND e.CreatedDate < ($2::DATE + INTERVAL '1 day')

        ORDER BY e.EquipmentID DESC

        LIMIT $4
        OFFSET $5;
      `,
      [
        dates.CurrentFromDate,
        dates.CurrentToDate,
        organizationID || null,
        pageSize,
        offset,
      ]
    );

    // ========================================================
    // 6. Total Count
    // ========================================================

    let totalCount = Number(
      result.rows[0]?.TotalCount ?? 0
    );

    // If requested page has no rows, still return total count.
    if (!result.rows.length) {
      const countResult = await pool.query(
        `
          SELECT COUNT(*)::BIGINT AS "TotalCount"

          FROM engineering_equipment_entry_master e

          WHERE e.IsDeleted = FALSE

            AND (
              $3::BIGINT IS NULL
              OR e.OrganizationID = $3::BIGINT
            )

            AND e.CreatedDate >= $1::DATE
            AND e.CreatedDate < ($2::DATE + INTERVAL '1 day');
        `,
        [
          dates.CurrentFromDate,
          dates.CurrentToDate,
          organizationID || null,
        ]
      );

      totalCount = Number(
        countResult.rows[0]?.TotalCount ?? 0
      );
    }

    // ========================================================
    // 7. Response Mapping
    // ========================================================

    const equipmentDetails = result.rows.map(
      (row, index) => {
        const {
          TotalCount,
          modifiedby,
          modifieddate,
          deletedby,
          deleteddate,
          departmentid,
          isdeleted,
          createdby,
          ...equipment
        } = row;

        for (const field of [
          "commissioningdate", "warrantystartdate", "warrantyenddate",
          "amcstartdate", "amcenddate", "createddate",
        ]) {
          equipment[field] = formatDate(equipment[field]);
        }

        return {
          SrNo: offset + index + 1,
          ...equipment,
        };
      }
    );

    // ========================================================
    // 8. Response
    // ========================================================

    return ok(
      "CEO equipment details fetched successfully.",
      equipmentDetails,
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalCount: totalCount,
        page: page,
        PageSize: pageSize,
        TotalPages: Math.ceil(totalCount / pageSize),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO equipment details"
    );
  }
};
// 22.2. ============================================================ Engineering Under Warranty Details
const getCEOUnderWarrantyDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================
    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================
    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Pagination Validation
    // ========================================================
    const page = Number(data.page ?? 1);
    const pageSize = Number(data.PageSize ?? 10);

    if (
      !Number.isSafeInteger(page) ||
      page <= 0 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      return fail("Invalid page or PageSize.", 400);
    }

    const offset = (page - 1) * pageSize;

    if (
      !Number.isSafeInteger(offset) ||
      offset > 2147483647
    ) {
      return fail("Pagination offset is too large.", 400);
    }

    // ========================================================
    // 4. Date Range (Existing Helper)
    // ========================================================
    const dates = getDateRange(filter);

    // ========================================================
    // 5. PostgreSQL Query
    // ========================================================
    const result = await pool.query(
      `
        SELECT
          e.*,
          org.ShortName AS "OrganizationShortName",
          COUNT(*) OVER()::BIGINT AS "TotalCount"

        FROM engineering_equipment_entry_master e
        LEFT JOIN Organization_Master org
          ON org.OrganizationID = e.OrganizationID

        WHERE e.IsDeleted = FALSE
          AND e.WarrantyStatus = 'Under Warranty'

          AND (
            $3::BIGINT IS NULL
            OR e.OrganizationID = $3::BIGINT
          )

          AND e.CreatedDate >= $1::DATE
          AND e.CreatedDate < ($2::DATE + INTERVAL '1 day')

        ORDER BY e.EquipmentID DESC

        LIMIT $4
        OFFSET $5;
      `,
      [
        dates.CurrentFromDate,
        dates.CurrentToDate,
        organizationID || null,
        pageSize,
        offset,
      ]
    );

    // ========================================================
    // 6. Total Count
    // ========================================================
    let totalCount = Number(
      result.rows[0]?.TotalCount ?? 0
    );

    // Empty page count fallback
    if (!result.rows.length) {
      const countResult = await pool.query(
        `
          SELECT COUNT(*)::BIGINT AS "TotalCount"

          FROM engineering_equipment_entry_master e

          WHERE e.IsDeleted = FALSE
            AND e.WarrantyStatus = 'Under Warranty'

            AND (
              $3::BIGINT IS NULL
              OR e.OrganizationID = $3::BIGINT
            )

            AND e.CreatedDate >= $1::DATE
            AND e.CreatedDate < ($2::DATE + INTERVAL '1 day');
        `,
        [
          dates.CurrentFromDate,
          dates.CurrentToDate,
          organizationID || null,
        ]
      );

      totalCount = Number(
        countResult.rows[0]?.TotalCount ?? 0
      );
    }

    // ========================================================
    // 7. Response Mapping
    // ========================================================
    const equipmentDetails = result.rows.map(
      (row, index) => {
        const {
          TotalCount,
          modifiedby,
          modifieddate,
          deletedby,
          deleteddate,
          departmentid,
          isdeleted,
          createdby,
          ...equipment
        } = row;

        for (const field of [
          "commissioningdate", "warrantystartdate", "warrantyenddate",
          "amcstartdate", "amcenddate", "createddate",
        ]) {
          equipment[field] = formatDate(equipment[field]);
        }

        return {
          SrNo: offset + index + 1,
          ...equipment,
        };
      }
    );

    // ========================================================
    // 8. Response
    // ========================================================
    return ok(
      "CEO under warranty details fetched successfully.",
      equipmentDetails,
      {
        Filter: filter,
        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalCount: totalCount,
        page: page,
        PageSize: pageSize,
        TotalPages: Math.ceil(totalCount / pageSize),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO under warranty details"
    );
  }
};
// 22.3. ============================================================ Engineering Under AMC Details
const getCEOUnderAMCDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Pagination Validation
    // ========================================================

    const page = Number(data.page ?? 1);
    const pageSize = Number(data.PageSize ?? 10);

    if (
      !Number.isSafeInteger(page) ||
      page <= 0 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      return fail("Invalid page or PageSize.", 400);
    }

    const offset = (page - 1) * pageSize;

    if (
      !Number.isSafeInteger(offset) ||
      offset > 2147483647
    ) {
      return fail("Pagination offset is too large.", 400);
    }

    // ========================================================
    // 4. Date Range (Existing Helper)
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 5. PostgreSQL Query
    // ========================================================

    const result = await pool.query(
      `
        SELECT
          e.*,
          org.ShortName AS "OrganizationShortName",
          COUNT(*) OVER()::BIGINT AS "TotalCount"

        FROM engineering_equipment_entry_master e
        LEFT JOIN Organization_Master org
          ON org.OrganizationID = e.OrganizationID

        WHERE e.IsDeleted = FALSE
          AND e.AMCStatus = 'Under AMC'

          AND (
            $3::BIGINT IS NULL
            OR e.OrganizationID = $3::BIGINT
          )

          AND e.CreatedDate >= $1::DATE
          AND e.CreatedDate < ($2::DATE + INTERVAL '1 day')

        ORDER BY e.EquipmentID DESC

        LIMIT $4
        OFFSET $5;
      `,
      [
        dates.CurrentFromDate,
        dates.CurrentToDate,
        organizationID || null,
        pageSize,
        offset,
      ]
    );

    // ========================================================
    // 6. Total Count
    // ========================================================

    let totalCount = Number(
      result.rows[0]?.TotalCount ?? 0
    );

    // Empty page count fallback
    if (!result.rows.length) {
      const countResult = await pool.query(
        `
          SELECT COUNT(*)::BIGINT AS "TotalCount"

          FROM engineering_equipment_entry_master e

          WHERE e.IsDeleted = FALSE
            AND e.AMCStatus = 'Under AMC'

            AND (
              $3::BIGINT IS NULL
              OR e.OrganizationID = $3::BIGINT
            )

            AND e.CreatedDate >= $1::DATE
            AND e.CreatedDate < ($2::DATE + INTERVAL '1 day');
        `,
        [
          dates.CurrentFromDate,
          dates.CurrentToDate,
          organizationID || null,
        ]
      );

      totalCount = Number(
        countResult.rows[0]?.TotalCount ?? 0
      );
    }

    // ========================================================
    // 7. Response Mapping
    // ========================================================

    const equipmentDetails = result.rows.map(
      (row, index) => {
        const {
          TotalCount,
          modifiedby,
          modifieddate,
          deletedby,
          deleteddate,
          departmentid,
          isdeleted,
          createdby,
          ...equipment
        } = row;

        for (const field of [
          "commissioningdate", "warrantystartdate", "warrantyenddate",
          "amcstartdate", "amcenddate", "createddate",
        ]) {
          equipment[field] = formatDate(equipment[field]);
        }

        return {
          SrNo: offset + index + 1,
          ...equipment,
        };
      }
    );

    // ========================================================
    // 8. Response
    // ========================================================

    return ok(
      "CEO under AMC details fetched successfully.",
      equipmentDetails,
      {
        Filter: filter,
        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalCount: totalCount,
        page: page,
        PageSize: pageSize,
        TotalPages: Math.ceil(totalCount / pageSize),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO under AMC details"
    );
  }
};
// 22.4. ============================================================ Engineering Total Breakdown Details
const formatDashboardEquipmentDetails = (equipment) => {
  if (!equipment) return null;
  const details = { ...equipment };
  for (const field of ["commissioningdate", "warrantystartdate", "warrantyenddate",
    "amcstartdate", "amcenddate", "createddate"]) {
    details[field] = formatDate(details[field]);
  }
  return details;
};
const getCEOTotalBreakdownDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Pagination Validation
    // ========================================================

    const page = Number(data.page ?? 1);
    const pageSize = Number(data.PageSize ?? 10);

    if (
      !Number.isSafeInteger(page) ||
      page <= 0 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      return fail(
        "Invalid page or PageSize.",
        400
      );
    }

    const offset = (page - 1) * pageSize;

    if (
      !Number.isSafeInteger(offset) ||
      offset > 2147483647
    ) {
      return fail(
        "Pagination offset is too large.",
        400
      );
    }

    // ========================================================
    // 4. Date Range (Existing Helper)
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 5. PostgreSQL Query
    // ========================================================

    const result = await pool.query(
      `
        SELECT
          b.*,
        (to_jsonb(equipment_detail) - ARRAY['modifiedby', 'modifieddate', 'deletedby',
          'deleteddate', 'departmentid', 'isdeleted', 'createdby']) AS "EquipmentDetails",
          org.ShortName AS "OrganizationShortName",

          COUNT(*) OVER()::BIGINT AS "TotalCount"

        FROM engineering_breakdown_entry b
        LEFT JOIN engineering_equipment_entry_master equipment_detail
          ON equipment_detail.EquipmentID = b.EquipmentID
          AND equipment_detail.OrganizationID = b.OrganizationID
          AND equipment_detail.IsDeleted = FALSE
        LEFT JOIN Organization_Master org
          ON org.OrganizationID = b.OrganizationID

        WHERE b.IsDeleted = FALSE

          AND (
            $3::BIGINT IS NULL
            OR b.OrganizationID = $3::BIGINT
          )

          AND b.CreatedDate >= $1::DATE
          AND b.CreatedDate < ($2::DATE + INTERVAL '1 day')

        ORDER BY b.CreatedDate DESC

        LIMIT $4
        OFFSET $5;
      `,
      [
        dates.CurrentFromDate,
        dates.CurrentToDate,
        organizationID || null,
        pageSize,
        offset,
      ]
    );

    // ========================================================
    // 6. Total Count
    // ========================================================

    let totalCount = Number(
      result.rows[0]?.TotalCount ?? 0
    );

    // If requested page has no rows,
    // fetch total count separately.

    if (!result.rows.length) {
      const countResult = await pool.query(
        `
          SELECT
            COUNT(*)::BIGINT AS "TotalCount"

          FROM engineering_breakdown_entry b

          WHERE b.IsDeleted = FALSE

            AND (
              $3::BIGINT IS NULL
              OR b.OrganizationID = $3::BIGINT
            )

            AND b.CreatedDate >= $1::DATE
            AND b.CreatedDate < ($2::DATE + INTERVAL '1 day');
        `,
        [
          dates.CurrentFromDate,
          dates.CurrentToDate,
          organizationID || null,
        ]
      );

      totalCount = Number(
        countResult.rows[0]?.TotalCount ?? 0
      );
    }

    // ========================================================
    // 7. Response Mapping
    // ========================================================

    for (const row of result.rows) {
      row.EquipmentDetails = formatDashboardEquipmentDetails(row.EquipmentDetails);
    }

    const breakdownDetails = result.rows.map(
      (row, index) => {
        const {
          TotalCount,
          modifiedby,
          modifieddate,
          deletedby,
          deleteddate,
          departmentid,
          isdeleted,
          createdby,
          ...breakdown
        } = row;

        for (const field of ["breakdowndate", "repaireddate", "createddate"]) {
          breakdown[field] = formatDate(breakdown[field]);
        }

        return {
          SrNo: offset + index + 1,
          ...breakdown,
        };
      }
    );

    // ========================================================
    // 8. Response
    // ========================================================

    return ok(
      "CEO total breakdown details fetched successfully.",
      breakdownDetails,
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalCount: totalCount,

        page: page,

        PageSize: pageSize,

        TotalPages: Math.ceil(totalCount / pageSize),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO total breakdown details"
    );
  }
};
// 22.5. ============================================================ Engineering Total Maintenance Details
const getCEOTotalMaintenanceDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Pagination Validation
    // ========================================================

    const page = Number(data.page ?? 1);
    const pageSize = Number(data.PageSize ?? 10);

    if (
      !Number.isSafeInteger(page) ||
      page <= 0 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      return fail(
        "Invalid page or PageSize.",
        400
      );
    }

    const offset = (page - 1) * pageSize;

    if (
      !Number.isSafeInteger(offset) ||
      offset > 2147483647
    ) {
      return fail(
        "Pagination offset is too large.",
        400
      );
    }

    // ========================================================
    // 4. Date Range (Existing Helper)
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 5. PostgreSQL Query
    // ========================================================

    const query = `
      WITH equipment AS
      (
        SELECT e.*
        FROM engineering_equipment_entry_master e

        WHERE e.IsDeleted = FALSE

          AND (
            $3::BIGINT IS NULL
            OR e.OrganizationID = $3::BIGINT
          )

          AND e.CreatedDate >= $1::DATE
          AND e.CreatedDate < ($2::DATE + INTERVAL '1 day')
      ),

      maintenance AS
      (
        SELECT m.*
        FROM engineering_maintenance_details m

        WHERE m.IsDeleted = FALSE

          AND (
            $3::BIGINT IS NULL
            OR m.OrganizationID = $3::BIGINT
          )

          AND m.MaintenanceDate >= $1::DATE
          AND m.MaintenanceDate < ($2::DATE + INTERVAL '1 day')
      ),

      scheduled_without_entry AS
      (
        SELECT e.*
        FROM equipment e

        WHERE NULLIF(
          TRIM(e.ScheduleOfServicing),
          ''
        ) IS NOT NULL

        AND NOT EXISTS
        (
          SELECT 1
          FROM maintenance m
          WHERE m.EquipmentID = e.EquipmentID
        )
      ),

      combined AS
      (
        -- ====================================================
        -- EXISTING MAINTENANCE RECORDS
        -- ====================================================

        SELECT
          'Maintenance Entry'::TEXT AS "RecordType",

          m.OrganizationID AS "OrganizationID",

          m.EquipmentID AS "EquipmentID",

          e.Description AS "EquipmentDescription",

          e.SerialNumber AS "SerialNumber",

          e.ScheduleOfServicing AS "ScheduleOfServicing",

          e.ScheduleDay AS "ScheduleDay",

          m.MaintenanceDate AS "MaintenanceDate",

          m.Status AS "Status"

        FROM maintenance m

        LEFT JOIN engineering_equipment_entry_master e
          ON e.EquipmentID = m.EquipmentID

        UNION ALL

        -- ====================================================
        -- SCHEDULED EQUIPMENTS WITHOUT ENTRY
        -- ====================================================

        SELECT
          'Scheduled Without Entry'::TEXT AS "RecordType",

          e.OrganizationID AS "OrganizationID",

          e.EquipmentID AS "EquipmentID",

          e.Description AS "EquipmentDescription",

          e.SerialNumber AS "SerialNumber",

          e.ScheduleOfServicing AS "ScheduleOfServicing",

          e.ScheduleDay AS "ScheduleDay",

          NULL AS "MaintenanceDate",

          'Pending' AS "Status"

        FROM scheduled_without_entry e
      )

      SELECT
        c.*,
        (to_jsonb(equipment_detail) - ARRAY['modifiedby', 'modifieddate', 'deletedby',
          'deleteddate', 'departmentid', 'isdeleted', 'createdby']) AS "EquipmentDetails",
        org.ShortName AS "OrganizationShortName",
        COUNT(*) OVER()::BIGINT AS "TotalCount"

      FROM combined c
        LEFT JOIN engineering_equipment_entry_master equipment_detail
          ON equipment_detail.EquipmentID = c."EquipmentID"
          AND equipment_detail.OrganizationID = c."OrganizationID"
          AND equipment_detail.IsDeleted = FALSE
      LEFT JOIN Organization_Master org
        ON org.OrganizationID = c."OrganizationID"

      ORDER BY
        c."OrganizationID",
        c."EquipmentID",
        c."MaintenanceDate" DESC NULLS LAST,
        c."RecordType"

      LIMIT $4
      OFFSET $5;
    `;

    const params = [
      dates.CurrentFromDate,
      dates.CurrentToDate,
      organizationID || null,
      pageSize,
      offset,
    ];

    const result = await pool.query(query, params);

    // ========================================================
    // 6. Total Count
    // ========================================================

    let totalCount = Number(
      result.rows[0]?.TotalCount ?? 0
    );

    // If page is empty, count matching records separately.
    if (!result.rows.length) {
      const countResult = await pool.query(
        `
          WITH equipment AS
          (
            SELECT e.EquipmentID
            FROM engineering_equipment_entry_master e

            WHERE e.IsDeleted = FALSE

              AND (
                $3::BIGINT IS NULL
                OR e.OrganizationID = $3::BIGINT
              )

              AND e.CreatedDate >= $1::DATE
              AND e.CreatedDate < ($2::DATE + INTERVAL '1 day')
          ),

          maintenance AS
          (
            SELECT
              m.EquipmentID

            FROM engineering_maintenance_details m

            WHERE m.IsDeleted = FALSE

              AND (
                $3::BIGINT IS NULL
                OR m.OrganizationID = $3::BIGINT
              )

              AND m.MaintenanceDate >= $1::DATE
              AND m.MaintenanceDate < ($2::DATE + INTERVAL '1 day')
          )

          SELECT
            (
              (SELECT COUNT(*) FROM maintenance)
              +
              (
                SELECT COUNT(*)
                FROM equipment e
                JOIN engineering_equipment_entry_master eq
                  ON eq.EquipmentID = e.EquipmentID

                WHERE NULLIF(
                  TRIM(eq.ScheduleOfServicing),
                  ''
                ) IS NOT NULL

                AND NOT EXISTS
                (
                  SELECT 1
                  FROM maintenance m
                  WHERE m.EquipmentID = e.EquipmentID
                )
              )
            )::BIGINT AS "TotalCount";
        `,
        [
          dates.CurrentFromDate,
          dates.CurrentToDate,
          organizationID || null,
        ]
      );

      totalCount = Number(
        countResult.rows[0]?.TotalCount ?? 0
      );
    }

    // ========================================================
    // 7. Response Mapping
    // ========================================================

    for (const row of result.rows) {
      row.EquipmentDetails = formatDashboardEquipmentDetails(row.EquipmentDetails);
    }

    const maintenanceDetails = result.rows.map(
      (row, index) => {
        const { TotalCount, ...maintenance } = row;

        return {
          SrNo: offset + index + 1,
          ...maintenance,
        };
      }
    );

    // ========================================================
    // 8. Response
    // ========================================================

    return ok(
      "CEO total maintenance details fetched successfully.",
      maintenanceDetails,
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalCount: totalCount,

        page: page,

        PageSize: pageSize,

        TotalPages: Math.ceil(totalCount / pageSize),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO total maintenance details"
    );
  }
};
// 22.6. ============================================================ Engineering Pending Maintenance Details
const getCEOPendingMaintenanceDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Pagination Validation
    // ========================================================

    const page = Number(data.page ?? 1);
    const pageSize = Number(data.PageSize ?? 10);

    if (
      !Number.isSafeInteger(page) ||
      page <= 0 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      return fail(
        "Invalid page or PageSize.",
        400
      );
    }

    const offset = (page - 1) * pageSize;

    if (
      !Number.isSafeInteger(offset) ||
      offset > 2147483647
    ) {
      return fail(
        "Pagination offset is too large.",
        400
      );
    }

    // ========================================================
    // 4. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 5. PostgreSQL Query
    // ========================================================

    const result = await pool.query(
      `
        SELECT
          m.*,
        (to_jsonb(equipment_detail) - ARRAY['modifiedby', 'modifieddate', 'deletedby',
          'deleteddate', 'departmentid', 'isdeleted', 'createdby']) AS "EquipmentDetails",
          org.ShortName AS "OrganizationShortName",
          COUNT(*) OVER()::BIGINT AS "TotalCount"

        FROM engineering_maintenance_details m
        LEFT JOIN engineering_equipment_entry_master equipment_detail
          ON equipment_detail.EquipmentID = m.EquipmentID
          AND equipment_detail.OrganizationID = m.OrganizationID
          AND equipment_detail.IsDeleted = FALSE
        LEFT JOIN Organization_Master org
          ON org.OrganizationID = m.OrganizationID

        WHERE m.IsDeleted = FALSE

          AND LOWER(TRIM(m.Status)) = 'pending'

          AND (
            $3::BIGINT IS NULL
            OR m.OrganizationID = $3::BIGINT
          )

          AND m.MaintenanceDate >= $1::DATE
          AND m.MaintenanceDate < ($2::DATE + INTERVAL '1 day')

        ORDER BY
          m.MaintenanceDate DESC,
          m.MaintenanceID DESC

        LIMIT $4
        OFFSET $5;
      `,
      [
        dates.CurrentFromDate,
        dates.CurrentToDate,
        organizationID || null,
        pageSize,
        offset,
      ]
    );

    // ========================================================
    // 6. Total Count
    // ========================================================

    let totalCount = Number(
      result.rows[0]?.TotalCount ?? 0
    );

    // Requested page empty ho toh total count fetch karo
    if (!result.rows.length) {
      const countResult = await pool.query(
        `
          SELECT
            COUNT(*)::BIGINT AS "TotalCount"

          FROM engineering_maintenance_details m

          WHERE m.IsDeleted = FALSE

            AND LOWER(TRIM(m.Status)) = 'pending'

            AND (
              $3::BIGINT IS NULL
              OR m.OrganizationID = $3::BIGINT
            )

            AND m.MaintenanceDate >= $1::DATE
            AND m.MaintenanceDate < ($2::DATE + INTERVAL '1 day');
        `,
        [
          dates.CurrentFromDate,
          dates.CurrentToDate,
          organizationID || null,
        ]
      );

      totalCount = Number(
        countResult.rows[0]?.TotalCount ?? 0
      );
    }

    // ========================================================
    // 7. Response Mapping
    // ========================================================

    for (const row of result.rows) {
      row.EquipmentDetails = formatDashboardEquipmentDetails(row.EquipmentDetails);
    }

    const maintenanceDetails = result.rows.map(
      (row, index) => {
        const {
          TotalCount, modifiedby, modifieddate, deletedby, deleteddate,
          departmentid, isdeleted, createdby, ...maintenance
        } = row;

        for (const field of ["maintenancedate", "createddate"]) {
          maintenance[field] = formatDate(maintenance[field]);
        }

        return {
          SrNo: offset + index + 1,
          ...maintenance,
        };
      }
    );

    // ========================================================
    // 8. Response
    // ========================================================

    return ok(
      "CEO pending maintenance details fetched successfully.",
      maintenanceDetails,
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalCount: totalCount,

        page: page,

        PageSize: pageSize,

        TotalPages: Math.ceil(totalCount / pageSize),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO pending maintenance details"
    );
  }
};
// 23. ============================================================ Engineering Maintenance Trend
const getCEOEngineeringMaintenanceChart = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. PostgreSQL Query
    // ========================================================

    const result = await pool.query(
      `
        WITH equipment AS
        (
          SELECT e.*
          FROM engineering_equipment_entry_master e

          WHERE e.IsDeleted = FALSE

            AND (
              $3::BIGINT IS NULL
              OR e.OrganizationID = $3::BIGINT
            )

            AND e.CreatedDate >= $1::DATE
            AND e.CreatedDate < ($2::DATE + INTERVAL '1 day')
        ),

        maintenance AS
        (
          SELECT m.*
          FROM engineering_maintenance_details m

          WHERE m.IsDeleted = FALSE

            AND (
              $3::BIGINT IS NULL
              OR m.OrganizationID = $3::BIGINT
            )

            AND m.MaintenanceDate >= $1::DATE
            AND m.MaintenanceDate < ($2::DATE + INTERVAL '1 day')
        ),

        scheduled_without_entry AS
        (
          SELECT
            e.EquipmentID,
            e.OrganizationID

          FROM equipment e

          WHERE NULLIF(
            TRIM(e.ScheduleOfServicing),
            ''
          ) IS NOT NULL

          AND NOT EXISTS
          (
            SELECT 1
            FROM maintenance m
            WHERE m.EquipmentID = e.EquipmentID
          )
        ),

        maintenance_counts AS
        (
          SELECT
            m.OrganizationID,

            COUNT(*) AS MaintenanceCount,

            COUNT(*) FILTER
            (
              WHERE LOWER(TRIM(m.Status)) = 'completed'
            ) AS CompletedCount

          FROM maintenance m

          GROUP BY m.OrganizationID
        ),

        scheduled_counts AS
        (
          SELECT
            OrganizationID,
            COUNT(*) AS ScheduledCount

          FROM scheduled_without_entry

          GROUP BY OrganizationID
        ),

        organizations AS
        (
          SELECT OrganizationID, ShortName
          FROM Organization_Master
          WHERE $3::BIGINT IS NULL OR OrganizationID = $3::BIGINT
        )

        SELECT
          o.OrganizationID AS "OrganizationID",

          o.ShortName AS "OrganizationShortName",

          (
            COALESCE(mc.MaintenanceCount, 0)
            +
            COALESCE(sc.ScheduledCount, 0)
          ) AS "NumberOfMaintenance",

          COALESCE(
            mc.CompletedCount,
            0
          ) AS "NumberOfMaintenanceCompleted"

        FROM organizations o

        LEFT JOIN maintenance_counts mc
          ON mc.OrganizationID = o.OrganizationID

        LEFT JOIN scheduled_counts sc
          ON sc.OrganizationID = o.OrganizationID

        ORDER BY o.OrganizationID;
      `,
      [
        dates.CurrentFromDate,
        dates.CurrentToDate,
        organizationID || null,
      ]
    );

    // ========================================================
    // 5. Response Mapping
    // ========================================================

    const chartData = result.rows.map((row) => ({
      OrganizationID: String(row.OrganizationID),

      OrganizationShortName: row.OrganizationShortName ?? null,

      NumberOfMaintenance: Number(
        row.NumberOfMaintenance ?? 0
      ),

      NumberOfMaintenanceCompleted: Number(
        row.NumberOfMaintenanceCompleted ?? 0
      ),
    }));

    // ========================================================
    // 6. Response
    // ========================================================

    return ok(
      "CEO engineering maintenance chart fetched successfully.",
      chartData,
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalOrganizations: chartData.length,
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO engineering maintenance chart"
    );
  }
};
// 23.1 ============================================================ Engineering Maintenance Trend Details
const getCEOCompletedMaintenanceDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Pagination Validation
    // ========================================================

    const page = Number(data.page ?? 1);
    const pageSize = Number(data.PageSize ?? 10);

    if (
      !Number.isSafeInteger(page) ||
      page <= 0 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      return fail(
        "Invalid page or PageSize.",
        400
      );
    }

    const offset = (page - 1) * pageSize;

    if (
      !Number.isSafeInteger(offset) ||
      offset > 2147483647
    ) {
      return fail(
        "Pagination offset is too large.",
        400
      );
    }

    // ========================================================
    // 4. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 5. PostgreSQL Query
    // ========================================================

    const result = await pool.query(
      `
        SELECT
          m.*,
        (to_jsonb(equipment_detail) - ARRAY['modifiedby', 'modifieddate', 'deletedby',
          'deleteddate', 'departmentid', 'isdeleted', 'createdby']) AS "EquipmentDetails",
          org.ShortName AS "OrganizationShortName",
          COUNT(*) OVER()::BIGINT AS "TotalCount"

        FROM engineering_maintenance_details m
        LEFT JOIN engineering_equipment_entry_master equipment_detail
          ON equipment_detail.EquipmentID = m.EquipmentID
          AND equipment_detail.OrganizationID = m.OrganizationID
          AND equipment_detail.IsDeleted = FALSE
        LEFT JOIN Organization_Master org
          ON org.OrganizationID = m.OrganizationID

        WHERE m.IsDeleted = FALSE

          AND LOWER(TRIM(m.Status)) = 'completed'

          AND (
            $3::BIGINT IS NULL
            OR m.OrganizationID = $3::BIGINT
          )

          AND m.MaintenanceDate >= $1::DATE
          AND m.MaintenanceDate < ($2::DATE + INTERVAL '1 day')

        ORDER BY
          m.MaintenanceDate DESC,
          m.MaintenanceID DESC

        LIMIT $4
        OFFSET $5;
      `,
      [
        dates.CurrentFromDate,
        dates.CurrentToDate,
        organizationID || null,
        pageSize,
        offset,
      ]
    );

    // ========================================================
    // 6. Total Count
    // ========================================================

    let totalCount = Number(
      result.rows[0]?.TotalCount ?? 0
    );

    // Requested page empty ho toh total count fetch karo
    if (!result.rows.length) {
      const countResult = await pool.query(
        `
          SELECT
            COUNT(*)::BIGINT AS "TotalCount"

          FROM engineering_maintenance_details m

          WHERE m.IsDeleted = FALSE

            AND LOWER(TRIM(m.Status)) = 'pending'

            AND (
              $3::BIGINT IS NULL
              OR m.OrganizationID = $3::BIGINT
            )

            AND m.MaintenanceDate >= $1::DATE
            AND m.MaintenanceDate < ($2::DATE + INTERVAL '1 day');
        `,
        [
          dates.CurrentFromDate,
          dates.CurrentToDate,
          organizationID || null,
        ]
      );

      totalCount = Number(
        countResult.rows[0]?.TotalCount ?? 0
      );
    }

    // ========================================================
    // 7. Response Mapping
    // ========================================================

    for (const row of result.rows) {
      row.EquipmentDetails = formatDashboardEquipmentDetails(row.EquipmentDetails);
    }

    const maintenanceDetails = result.rows.map(
      (row, index) => {
        const {
          TotalCount, modifiedby, modifieddate, deletedby, deleteddate,
          departmentid, isdeleted, createdby, ...maintenance
        } = row;

        for (const field of ["maintenancedate", "createddate"]) {
          maintenance[field] = formatDate(maintenance[field]);
        }

        return {
          SrNo: offset + index + 1,
          ...maintenance,
        };
      }
    );

    // ========================================================
    // 8. Response
    // ========================================================

    return ok(
      "CEO pending maintenance details fetched successfully.",
      maintenanceDetails,
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalCount: totalCount,

        page: page,

        PageSize: pageSize,

        TotalPages: Math.ceil(totalCount / pageSize),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO pending maintenance details"
    );
  }
};
// 24. ============================================================ Engineering Breakdown Trend
const getCEOEngineeringBreakdownChart = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. PostgreSQL Query
    // ========================================================

    const result = await pool.query(
      `
        WITH breakdowns AS
        (
          SELECT
            b.OrganizationID,
            b.CreatedDate

          FROM engineering_breakdown_entry b

          WHERE b.IsDeleted = FALSE

            AND (
              $3::BIGINT IS NULL
              OR b.OrganizationID = $3::BIGINT
            )

            AND b.CreatedDate >= $1::DATE
            AND b.CreatedDate < ($2::DATE + INTERVAL '1 day')
        ),

        breakdown_counts AS
        (
          SELECT
            OrganizationID,
            COUNT(*) AS BreakdownCount

          FROM breakdowns

          GROUP BY OrganizationID
        ),

        organizations AS
        (
          SELECT
            OrganizationID,
            ShortName

          FROM Organization_Master

          WHERE (
            $3::BIGINT IS NULL
            OR OrganizationID = $3::BIGINT
          )
        )

        SELECT
          o.OrganizationID AS "OrganizationID",

          o.ShortName AS "OrganizationShortName",

          COALESCE(
            bc.BreakdownCount,
            0
          ) AS "NumberOfBreakdown"

        FROM organizations o

        LEFT JOIN breakdown_counts bc
          ON bc.OrganizationID = o.OrganizationID

        ORDER BY o.OrganizationID;
      `,
      [
        dates.CurrentFromDate,
        dates.CurrentToDate,
        organizationID || null,
      ]
    );

    // ========================================================
    // 5. Response Mapping
    // ========================================================

    const chartData = result.rows.map((row) => ({
      OrganizationID: String(row.OrganizationID),

      OrganizationShortName:
        row.OrganizationShortName ?? null,

      NumberOfBreakdown: Number(
        row.NumberOfBreakdown ?? 0
      ),
    }));

    // ========================================================
    // 6. Response
    // ========================================================

    return ok(
      "CEO engineering breakdown chart fetched successfully.",
      chartData,
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalOrganizations: chartData.length,
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO engineering breakdown chart"
    );
  }
};
// 25. ============================================================ Daily Breakage Trend
const getCEODailyBreakageChart = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. PostgreSQL Query
    // ========================================================

    const result = await pool.query(
      `
        WITH breakage_cost AS
        (
          SELECT
            m.OrganizationID,

            SUM(
              COALESCE(d.TotalCost, 0)
            ) AS TotalCost

          FROM daily_breakage_entry_master m

          INNER JOIN daily_breakage_entry_details d
            ON m.DailyBreakageID = d.DailyBreakageID

          WHERE m.IsDeleted = FALSE
            AND d.IsDeleted = FALSE

            AND (
              $3::BIGINT IS NULL
              OR m.OrganizationID = $3::BIGINT
            )

            AND m.EntryDate >= $1::DATE
            AND m.EntryDate < ($2::DATE + INTERVAL '1 day')

          GROUP BY m.OrganizationID
        ),

        organizations AS
        (
          SELECT
            OrganizationID,
            ShortName

          FROM Organization_Master

          WHERE (
            $3::BIGINT IS NULL
            OR OrganizationID = $3::BIGINT
          )
        )

        SELECT
          o.OrganizationID AS "OrganizationID",

          o.ShortName AS "OrganizationShortName",

          COALESCE(
            bc.TotalCost,
            0
          ) AS "TotalCost"

        FROM organizations o

        LEFT JOIN breakage_cost bc
          ON bc.OrganizationID = o.OrganizationID

        ORDER BY o.OrganizationID;
      `,
      [
        dates.CurrentFromDate,
        dates.CurrentToDate,
        organizationID || null,
      ]
    );

    // ========================================================
    // 5. Response Mapping
    // ========================================================

    const chartData = result.rows.map((row) => ({
      OrganizationID: String(row.OrganizationID),

      OrganizationShortName:
        row.OrganizationShortName ?? null,

      TotalCost: Number(row.TotalCost ?? 0),
    }));

    // ========================================================
    // 6. Response
    // ========================================================

    return ok(
      "CEO daily breakage chart fetched successfully.",
      chartData,
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalOrganizations: chartData.length,
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO daily breakage chart"
    );
  }
};
// 25.1 ============================================================ Daily Breakage Details
const getCEODailyBreakageDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Pagination Validation
    // ========================================================

    const page = Number(data.page ?? 1);
    const pageSize = Number(data.PageSize ?? 10);

    if (
      !Number.isSafeInteger(page) ||
      page <= 0 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      return fail(
        "Invalid page or PageSize.",
        400
      );
    }

    const offset = (page - 1) * pageSize;

    if (
      !Number.isSafeInteger(offset) ||
      offset > 2147483647
    ) {
      return fail(
        "Pagination offset is too large.",
        400
      );
    }

    // ========================================================
    // 4. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 5. PostgreSQL Query
    // ========================================================

    const result = await pool.query(
      `
        WITH breakage_details AS
        (
          SELECT
            m.OrganizationID,
            m.DailyBreakageID,
            m.EntryDate,
            m.Outlet,

            d.DailyBreakageDetailID,
            d.Item,
            d.Nos,
            d.TotalCost,
            d.PersonResponsible

          FROM daily_breakage_entry_master m

          INNER JOIN daily_breakage_entry_details d
            ON m.DailyBreakageID = d.DailyBreakageID

          WHERE m.IsDeleted = FALSE
            AND d.IsDeleted = FALSE

            AND (
              $3::BIGINT IS NULL
              OR m.OrganizationID = $3::BIGINT
            )

            AND m.EntryDate >= $1::DATE
            AND m.EntryDate < ($2::DATE + INTERVAL '1 day')
        ),

        numbered_details AS
        (
          SELECT
            ROW_NUMBER() OVER (
              ORDER BY
                EntryDate DESC,
                DailyBreakageDetailID
            ) AS "SrNo",

            OrganizationID AS "OrganizationID",

            Item AS "Item",

            Nos AS "Nos",

            TotalCost AS "TotalCost",

            PersonResponsible AS "PersonResponsible"

          FROM breakage_details
        )

        SELECT
          nd.*,
          COUNT(*) OVER()::BIGINT AS "TotalCount"

        FROM numbered_details nd

        ORDER BY nd."SrNo"

        LIMIT $4
        OFFSET $5;
      `,
      [
        dates.CurrentFromDate,
        dates.CurrentToDate,
        organizationID || null,
        pageSize,
        offset,
      ]
    );

    // ========================================================
    // 6. Total Count
    // ========================================================

    let totalCount = Number(
      result.rows[0]?.TotalCount ?? 0
    );

    // Empty page count fallback
    if (!result.rows.length) {
      const countResult = await pool.query(
        `
          SELECT
            COUNT(*)::BIGINT AS "TotalCount"

          FROM daily_breakage_entry_master m

          INNER JOIN daily_breakage_entry_details d
            ON m.DailyBreakageID = d.DailyBreakageID

          WHERE m.IsDeleted = FALSE
            AND d.IsDeleted = FALSE

            AND (
              $3::BIGINT IS NULL
              OR m.OrganizationID = $3::BIGINT
            )

            AND m.EntryDate >= $1::DATE
            AND m.EntryDate < ($2::DATE + INTERVAL '1 day');
        `,
        [
          dates.CurrentFromDate,
          dates.CurrentToDate,
          organizationID || null,
        ]
      );

      totalCount = Number(
        countResult.rows[0]?.TotalCount ?? 0
      );
    }

    // ========================================================
    // 7. Response Mapping
    // ========================================================

    const breakageDetails = result.rows.map((row) => ({
      SrNo: Number(row.SrNo),

      OrganizationID: String(row.OrganizationID),

      Item: row.Item ?? null,

      Nos: Number(row.Nos ?? 0),

      TotalCost: Number(row.TotalCost ?? 0),

      PersonResponsible: row.PersonResponsible ?? null,
    }));

    const totals = breakageDetails.reduce((sum, row) => ({
      Nos: sum.Nos + row.Nos,
      TotalCost: sum.TotalCost + row.TotalCost,
    }), { Nos: 0, TotalCost: 0 });

    breakageDetails.push({
      SrNo: null,
      OrganizationID: organizationID || null,
      Item: "Total",
      Nos: totals.Nos,
      TotalCost: Number(totals.TotalCost.toFixed(2)),
      PersonResponsible: null,
      IsTotal: true,
    });

    // ========================================================
    // 8. Response
    // ========================================================

    return ok(
      "CEO daily breakage details fetched successfully.",
      breakageDetails,
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalCount: totalCount,

        page: page,

        PageSize: pageSize,

        TotalPages: Math.ceil(totalCount / pageSize),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO daily breakage details"
    );
  }
};
// 26. ============================================================ HLP Report Trend
const getCEOHLPReportChart = async (data) => {
  try {
    // ========================================================
    // 1. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 2. EntryDate Validation
    // ========================================================

    const entryDate = String(data.EntryDate || "").trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
      return fail(
        "EntryDate is required in YYYY-MM-DD format.",
        400
      );
    }

    const [year, month, day] = entryDate
      .split("-")
      .map(Number);

    const parsedDate = new Date(
      Date.UTC(year, month - 1, day)
    );

    if (
      parsedDate.getUTCFullYear() !== year ||
      parsedDate.getUTCMonth() !== month - 1 ||
      parsedDate.getUTCDate() !== day
    ) {
      return fail(
        "Invalid EntryDate.",
        400
      );
    }

    // ========================================================
    // 3. PostgreSQL Query
    // ========================================================

    const result = await pool.query(
      `
        WITH hlp_data AS
        (
          SELECT
            m.id AS "EntryID",

            m.organizationid AS "OrganizationID",

            m.entrydate AS "EntryDate",

            d.id AS "DetailID",

            d.masterid AS "MasterListID",

            COALESCE(
              NULLIF(TRIM(d.title), ''),
              l.title
            ) AS "Label",

            d.yod AS "YOD",

            d.lyod AS "LYOD",

            l.orderby AS "SortOrder"

          FROM hlpreport_entry_master m

          INNER JOIN hlpreport_entry_details d
            ON d.entryid = m.id

          LEFT JOIN hlpreport_master_list l
            ON l.id = d.masterid
            AND l.organizationid = m.organizationid

          WHERE (
            $1::BIGINT IS NULL
            OR m.organizationid = $1::BIGINT
          )

          AND m.entrydate = $2::DATE
        )

        SELECT
          "OrganizationID",

          "EntryDate",

          "EntryID",

          "DetailID",

          "MasterListID",

          "Label",

          COALESCE(
            NULLIF(
              REGEXP_REPLACE(
                "YOD",
                '[^0-9.-]',
                '',
                'g'
              ),
              ''
            )::NUMERIC,
            0
          ) AS "Total",

          COALESCE(
            NULLIF(
              REGEXP_REPLACE(
                "LYOD",
                '[^0-9.-]',
                '',
                'g'
              ),
              ''
            )::NUMERIC,
            0
          ) AS "LastYearTotal"

        FROM hlp_data

        ORDER BY
          "SortOrder" ASC NULLS LAST,
          "DetailID" ASC;
      `,
      [
        organizationID || null,
        entryDate,
      ]
    );

    // ========================================================
    // 4. Response Mapping
    // ========================================================

    const chartData = result.rows.map((row) => ({
      OrganizationID:
        row.OrganizationID == null
          ? null
          : String(row.OrganizationID),

      EntryDate: entryDate,

      EntryID: Number(row.EntryID),

      DetailID: Number(row.DetailID),

      MasterListID:
        row.MasterListID == null
          ? null
          : Number(row.MasterListID),

      Label: row.Label ?? null,

      Total: Number(row.Total ?? 0),

      LastYearTotal: Number(
        row.LastYearTotal ?? 0
      ),
    }));

    // ========================================================
    // 5. Response
    // ========================================================

    return ok(
      "CEO HLP report chart fetched successfully.",
      chartData,
      {
        OrganizationID: organizationID || null,

        EntryDate: entryDate,

        TotalRecords: chartData.length,
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO HLP report chart"
    );
  }
};
// 27. ============================================================ Catering Trend
const getCEOCateringSalesChart = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 5. MSSQL Query
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .input(
        "FromDate",
        sql.Date,
        dates.CurrentFromDate
      )
      .input(
        "ToDate",
        sql.Date,
        dates.CurrentToDate
      )
      .query(`
        SELECT
          org.OrganizationID,

          dbo.FN_Get_OrganizationShortName(
            org.OrganizationID
          ) AS Hotel,

          ISNULL(b.Total, 0) AS Total

        FROM dbo.htl_tbl_organization_master AS org

        LEFT JOIN
        (
          SELECT
            a.OrganizationID,
            COUNT(a.ID) AS Total

          FROM BQ_Tbl_Booking_Master AS a

          WHERE a.BookingStatus = 10

            AND a.ArrivalDate >= @FromDate
            AND a.ArrivalDate < DATEADD(DAY, 1, @ToDate)

          GROUP BY a.OrganizationID

        ) AS b
          ON org.OrganizationID = b.OrganizationID

        WHERE org.Activation_status = 1
          AND org.IsNileHotel = 1
          AND org.OrganizationID <> 3

          AND (
            @OrganizationID IS NULL
            OR org.OrganizationID = @OrganizationID
          )

        ORDER BY Hotel;
      `);

    // ========================================================
    // 6. Response Mapping
    // ========================================================

    const chartData = result.recordset.map((row) => ({
      OrganizationID: String(row.OrganizationID),
      Hotel: row.Hotel ?? null,
      Total: Number(row.Total ?? 0),
    }));

    // ========================================================
    // 7. Response
    // ========================================================

    return ok(
      "CEO catering sales chart fetched successfully.",
      chartData,
      {
        Filter: filter,
        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalOrganizations: chartData.length,
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO catering sales chart"
    );
  }
};
// 27.1. ====================================================== Catering Details
const getCEOCateringSalesDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Pagination Validation
    // ========================================================

    const page = Number(data.page ?? 1);
    const pageSize = Number(data.PageSize ?? 10);

    if (
      !Number.isSafeInteger(page) ||
      page <= 0 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      return fail(
        "Invalid page or PageSize.",
        400
      );
    }

    const offset = (page - 1) * pageSize;

    if (
      !Number.isSafeInteger(offset) ||
      offset > 2147483647 - pageSize
    ) {
      return fail(
        "Pagination offset is too large.",
        400
      );
    }

    // ========================================================
    // 4. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 5. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 6. MSSQL Query
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .input(
        "FromDate",
        sql.Date,
        dates.CurrentFromDate
      )
      .input(
        "ToDate",
        sql.Date,
        dates.CurrentToDate
      )
      .input("Offset", sql.Int, offset)
      .input("PageSize", sql.Int, pageSize)
      .query(`
        ;WITH CateringData AS
        (
          SELECT
            ROW_NUMBER() OVER (
              ORDER BY
                a.ArrivalDate DESC,
                a.ID DESC
            ) AS SrNo,

            a.OrganizationID,

            dbo.FN_Get_OrganizationShortName(
              a.OrganizationID
            ) AS Hotel,

            a.ID AS BookingID,

            a.FunctionName,

            CONVERT(
              VARCHAR(11),
              a.ArrivalDate,
              106
            ) AS ArrivalDate,

            CONVERT(
              VARCHAR(11),
              a.DepartureDate,
              106
            ) AS DepartureDate,

            a.Attending,

            am.CompanyName,

            ISNULL(c.FirstName, '') + ' ' +
            ISNULL(c.MiddleName, '') + ' ' +
            ISNULL(c.LastName, '') AS ContactName

          FROM BQ_Tbl_Booking_Master AS a

          INNER JOIN BQ_Tbl_Account_Master AS am
            ON a.AccountID = am.ID

          INNER JOIN BQ_Tbl_CompanyContact AS c
            ON a.ContactID = c.ID

          INNER JOIN dbo.htl_tbl_organization_master AS org
            ON a.OrganizationID = org.OrganizationID

          WHERE a.BookingStatus = 10

            AND org.Activation_status = 1
            AND org.IsNileHotel = 1
            AND org.OrganizationID <> 3

            AND (
              @OrganizationID IS NULL
              OR a.OrganizationID = @OrganizationID
            )

            AND a.ArrivalDate >= @FromDate
            AND a.ArrivalDate < DATEADD(DAY, 1, @ToDate)
        )

        -- ====================================================
        -- RESULT SET 1: PAGINATED EVENT DETAILS
        -- ====================================================

        SELECT
          SrNo,
          OrganizationID,
          Hotel,
          BookingID,
          FunctionName,
          CompanyName,
          ContactName,
          Attending,
          ArrivalDate,
          DepartureDate

        FROM CateringData

        WHERE SrNo > @Offset
          AND SrNo <= @Offset + @PageSize

        ORDER BY SrNo;

        -- ====================================================
        -- RESULT SET 2: TOTAL COUNT
        -- ====================================================

        SELECT COUNT(*) AS TotalCount

        FROM BQ_Tbl_Booking_Master AS a

        INNER JOIN BQ_Tbl_Account_Master AS am
          ON a.AccountID = am.ID

        INNER JOIN BQ_Tbl_CompanyContact AS c
          ON a.ContactID = c.ID

        INNER JOIN dbo.htl_tbl_organization_master AS org
          ON a.OrganizationID = org.OrganizationID

        WHERE a.BookingStatus = 10

          AND org.Activation_status = 1
          AND org.IsNileHotel = 1
          AND org.OrganizationID <> 3

          AND (
            @OrganizationID IS NULL
            OR a.OrganizationID = @OrganizationID
          )

          AND a.ArrivalDate >= @FromDate
          AND a.ArrivalDate < DATEADD(DAY, 1, @ToDate);
      `);

    // ========================================================
    // 7. Total Count
    // ========================================================

    const totalCount = Number(
      result.recordsets?.[1]?.[0]?.TotalCount ?? 0
    );

    // ========================================================
    // 8. Response Mapping
    // ========================================================

    const eventDetails = (
      result.recordsets?.[0] ?? []
    ).map((row) => ({
      SrNo: Number(row.SrNo),

      OrganizationID:
        row.OrganizationID == null
          ? null
          : String(row.OrganizationID),

      Hotel: row.Hotel ?? null,

      BookingID:
        row.BookingID == null
          ? null
          : String(row.BookingID),

      FunctionName: row.FunctionName ?? null,

      CompanyName: row.CompanyName ?? null,

      ContactName: row.ContactName?.trim() || null,

      Attending:
        row.Attending == null
          ? null
          : Number(row.Attending),

      ArrivalDate: row.ArrivalDate ?? null,

      DepartureDate: row.DepartureDate ?? null,
    }));

    // ========================================================
    // 9. Response
    // ========================================================

    return ok(
      "CEO catering sales details fetched successfully.",
      eventDetails,
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalCount: totalCount,
        page: page,
        PageSize: pageSize,
        TotalPages: Math.ceil(totalCount / pageSize),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO catering sales details"
    );
  }
};
// 28. ============================================================ Sales Contracts Trend
const getCEOSalesContractChart = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 5. MSSQL Query
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .input(
        "FromDate",
        sql.Date,
        dates.CurrentFromDate
      )
      .input(
        "ToDate",
        sql.Date,
        dates.CurrentToDate
      )
      .query(`
        ;WITH Hotels AS
        (
          SELECT
            org.OrganizationID,

            dbo.FN_Get_OrganizationShortName(
              org.OrganizationID
            ) AS Hotel

          FROM dbo.htl_tbl_organization_master AS org

          WHERE org.Activation_status = 1
            AND org.IsNileHotel = 1

            AND (
              @OrganizationID IS NULL
              OR org.OrganizationID = @OrganizationID
            )
        ),

        -- ====================================================
        -- LATEST CONTRACT OF EACH VENDOR
        -- ====================================================

        VendorContracts AS
        (
          SELECT
            v.OrganizationID,
            v.VendorID,

            latest.ContractExists,
            latest.FromDate,
            latest.ToDate

          FROM SalesContract.SalesContract_Tbl_VendorProfile_Master AS v

          OUTER APPLY
          (
            SELECT TOP (1)
              1 AS ContractExists,
              c.FromDate,
              c.ToDate

            FROM SalesContract.SalesContract_Tbl_Vendor_ContractEntry_Master AS c

            WHERE c.VendorID = v.VendorID

            ORDER BY c.CreatedDatetime DESC

          ) AS latest

          WHERE v.VendorStatus <> 'Archive'
        ),

        -- ====================================================
        -- DATE RANGE OVERLAP
        -- ====================================================

        FilteredContracts AS
        (
          SELECT *
          FROM VendorContracts

          WHERE ContractExists = 1

            AND FromDate < DATEADD(DAY, 1, @ToDate)
            AND ToDate >= @FromDate
        ),

        -- ====================================================
        -- CONTRACT COUNTS
        -- ====================================================

        ContractCounts AS
        (
          SELECT
            OrganizationID,

            COUNT(*) AS Total,

            SUM(
              CASE
                WHEN ToDate >= CAST(GETDATE() AS DATE)
                THEN 1 ELSE 0
              END
            ) AS TotalActive,

            SUM(
              CASE
                WHEN ToDate < CAST(GETDATE() AS DATE)
                THEN 1 ELSE 0
              END
            ) AS TotalExpired

          FROM FilteredContracts

          GROUP BY OrganizationID
        )

        -- ====================================================
        -- HOTEL WISE RESULT
        -- ====================================================

        SELECT
          h.Hotel,
          h.OrganizationID,

          ISNULL(c.Total, 0) AS Total,

          ISNULL(c.TotalActive, 0) AS TotalActive,

          ISNULL(c.TotalExpired, 0) AS TotalExpired

        FROM Hotels h

        LEFT JOIN ContractCounts c
          ON h.OrganizationID = c.OrganizationID

        ORDER BY h.Hotel;
      `);

    // ========================================================
    // 6. Response Mapping
    // ========================================================

    const chartData = result.recordset.map((row) => ({
      OrganizationID:
        row.OrganizationID == null
          ? null
          : String(row.OrganizationID),

      Hotel: row.Hotel ?? null,

      Total: Number(row.Total ?? 0),

      TotalActive: Number(row.TotalActive ?? 0),

      TotalExpired: Number(row.TotalExpired ?? 0),
    }));

    // ========================================================
    // 7. Overall Totals
    // ========================================================

    const totals = chartData.reduce(
      (acc, row) => {
        acc.TotalContracts += row.Total;
        acc.TotalActive += row.TotalActive;
        acc.TotalExpired += row.TotalExpired;
        return acc;
      },
      {
        TotalContracts: 0,
        TotalActive: 0,
        TotalExpired: 0,
      }
    );

    // ========================================================
    // 8. Response
    // ========================================================

    return ok(
      "CEO sales contract chart fetched successfully.",
      chartData,
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalOrganizations: chartData.length,

        ...totals,
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO sales contract chart"
    );
  }
};
// 28.1 ============================================================ Sales Contracts Details
const getCEOSalesContractDetails = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. Status Validation
    // ========================================================

    const status = String(data.Status || "Total")
      .trim()
      .toLowerCase();

    if (
      !["total", "active", "expired"].includes(status)
    ) {
      return fail(
        "Status must be Total, Active or Expired.",
        400
      );
    }

    const statusValue =
      status.charAt(0).toUpperCase() + status.slice(1);

    // ========================================================
    // 3. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 4. Pagination Validation
    // ========================================================

    const page = Number(data.page ?? 1);
    const pageSize = Number(data.PageSize ?? 10);

    if (
      !Number.isSafeInteger(page) ||
      page <= 0 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    ) {
      return fail(
        "Invalid page or PageSize.",
        400
      );
    }

    const offset = (page - 1) * pageSize;

    if (
      !Number.isSafeInteger(offset) ||
      offset > 2147483647 - pageSize
    ) {
      return fail(
        "Pagination offset is too large.",
        400
      );
    }

    // ========================================================
    // 5. Date Range
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 6. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 7. MSSQL Query
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .input("Status", sql.NVarChar(50), statusValue)
      .input(
        "FromDate",
        sql.Date,
        dates.CurrentFromDate
      )
      .input(
        "ToDate",
        sql.Date,
        dates.CurrentToDate
      )
      .input("Offset", sql.Int, offset)
      .input("PageSize", sql.Int, pageSize)
      .query(`
        ;WITH Hotels AS
        (
          SELECT
            org.OrganizationID,

            dbo.FN_Get_OrganizationShortName(
              org.OrganizationID
            ) AS Hotel

          FROM dbo.htl_tbl_organization_master AS org

          WHERE org.Activation_status = 1
            AND org.IsNileHotel = 1

            AND (
              @OrganizationID IS NULL
              OR org.OrganizationID = @OrganizationID
            )
        ),

        -- ====================================================
        -- LATEST CONTRACT PER VENDOR
        -- ====================================================

        LatestContracts AS
        (
          SELECT
            v.OrganizationID,
            v.VendorID,
            v.CompanyName,
            v.FirstName,
            v.LastName,
            v.AccountManager,
            v.CreditApproved,

            latest.ID AS ContractID,
            latest.FromDate,
            latest.ToDate,
            latest.SignedContractFiles

          FROM SalesContract.SalesContract_Tbl_VendorProfile_Master AS v

          INNER JOIN Hotels h
            ON h.OrganizationID = v.OrganizationID

          CROSS APPLY
          (
            SELECT TOP (1)
              c.ID,
              c.FromDate,
              c.ToDate,
              c.SignedContractFiles

            FROM SalesContract.SalesContract_Tbl_Vendor_ContractEntry_Master AS c

            WHERE c.VendorID = v.VendorID

            ORDER BY c.CreatedDatetime DESC

          ) AS latest

          WHERE v.VendorStatus <> 'Archive'
        ),

        -- ====================================================
        -- STATUS + DATE FILTER
        -- ====================================================

        FilteredContracts AS
        (
          SELECT *
          FROM LatestContracts

          WHERE
          (
            @Status = 'Total'

            OR (
              @Status = 'Active'
              AND ToDate >= CAST(GETDATE() AS DATE)
            )

            OR (
              @Status = 'Expired'
              AND ToDate < CAST(GETDATE() AS DATE)
            )
          )

          AND FromDate < DATEADD(DAY, 1, @ToDate)
          AND ToDate >= @FromDate
        ),

        -- ====================================================
        -- NUMBERED DETAILS + TOTAL COUNT
        -- ====================================================

        NumberedData AS
        (
          SELECT
            ROW_NUMBER() OVER (
              ORDER BY
                fc.OrganizationID,
                fc.ToDate DESC,
                fc.ContractID DESC
            ) AS SrNo,

            COUNT(*) OVER() AS TotalCount,

            fc.OrganizationID,

            dbo.FN_Get_OrganizationShortName(
              fc.OrganizationID
            ) AS Hotel,

            fc.ContractID,
            fc.VendorID,
            fc.CompanyName,

            LTRIM(RTRIM(
              ISNULL(fc.FirstName, '') + ' ' +
              ISNULL(fc.LastName, '')
            )) AS VendorName,

            CONVERT(
              VARCHAR(11),
              fc.FromDate,
              106
            ) AS FromDate,

            CONVERT(
              VARCHAR(11),
              fc.ToDate,
              106
            ) AS ToDate,

            CASE
              WHEN ISNULL(fc.SignedContractFiles, '') = ''
                THEN 'Pending'
              ELSE 'Uploaded'
            END AS UploadStatus,

            fc.AccountManager,
            fc.CreditApproved,

            CASE
              WHEN fc.ToDate >= CAST(GETDATE() AS DATE)
                THEN 'Active'

              WHEN fc.ToDate < CAST(GETDATE() AS DATE)
                THEN 'Expired'

              ELSE 'Unknown'
            END AS ContractStatus

          FROM FilteredContracts AS fc
        )

        -- ====================================================
        -- PAGINATED DETAILS
        -- ====================================================

        SELECT *
        FROM NumberedData

        WHERE SrNo > @Offset
          AND SrNo <= @Offset + @PageSize

        ORDER BY SrNo;
      `);

    // ========================================================
    // 8. Total Count
    // ========================================================

    let totalCount = Number(
      result.recordset[0]?.TotalCount ?? 0
    );

    // Empty page count fallback
    if (!result.recordset.length) {
      const countResult = await mssqlPool
        .request()
        .input(
          "OrganizationID",
          sql.BigInt,
          organizationID || null
        )
        .input("Status", sql.NVarChar(50), statusValue)
        .input(
          "FromDate",
          sql.Date,
          dates.CurrentFromDate
        )
        .input(
          "ToDate",
          sql.Date,
          dates.CurrentToDate
        )
        .query(`
          SELECT COUNT(*) AS TotalCount

          FROM SalesContract.SalesContract_Tbl_VendorProfile_Master AS v

          INNER JOIN dbo.htl_tbl_organization_master AS org
            ON org.OrganizationID = v.OrganizationID

          CROSS APPLY
          (
            SELECT TOP (1)
              c.FromDate,
              c.ToDate

            FROM SalesContract.SalesContract_Tbl_Vendor_ContractEntry_Master AS c

            WHERE c.VendorID = v.VendorID

            ORDER BY c.CreatedDatetime DESC
          ) AS latest

          WHERE org.Activation_status = 1
            AND org.IsNileHotel = 1

            AND v.VendorStatus <> 'Archive'

            AND (
              @OrganizationID IS NULL
              OR v.OrganizationID = @OrganizationID
            )

            AND (
              @Status = 'Total'

              OR (
                @Status = 'Active'
                AND latest.ToDate >= CAST(GETDATE() AS DATE)
              )

              OR (
                @Status = 'Expired'
                AND latest.ToDate < CAST(GETDATE() AS DATE)
              )
            )

            AND latest.FromDate <
              DATEADD(DAY, 1, @ToDate)

            AND latest.ToDate >= @FromDate;
        `);

      totalCount = Number(
        countResult.recordset[0]?.TotalCount ?? 0
      );
    }

    // ========================================================
    // 9. Response Mapping
    // ========================================================

    const contractDetails = result.recordset.map((row) => ({
      SrNo: Number(row.SrNo),

      OrganizationID:
        row.OrganizationID == null
          ? null
          : String(row.OrganizationID),

      Hotel: row.Hotel ?? null,

      ContractID:
        row.ContractID == null
          ? null
          : String(row.ContractID),

      VendorID:
        row.VendorID == null
          ? null
          : String(row.VendorID),

      CompanyName: row.CompanyName ?? null,

      VendorName: row.VendorName ?? null,

      FromDate: row.FromDate ?? null,

      ToDate: row.ToDate ?? null,

      UploadStatus: row.UploadStatus ?? null,

      AccountManager: row.AccountManager ?? null,

      CreditApproved: row.CreditApproved ?? null,

      ContractStatus: row.ContractStatus ?? null,
    }));

    // ========================================================
    // 10. Response
    // ========================================================

    return ok(
      "CEO sales contract details fetched successfully.",
      contractDetails,
      {
        Filter: filter,

        Status: statusValue,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalCount: totalCount,

        page: page,

        PageSize: pageSize,

        TotalPages: Math.ceil(totalCount / pageSize),
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO sales contract details"
    );
  }
};
// 29. ============================================================ Revenue Trend
const getCEOARRRevPARChart = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range (Existing Helper)
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 5. MSSQL Query
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .input(
        "FromDate",
        sql.Date,
        dates.CurrentFromDate
      )
      .input(
        "ToDate",
        sql.Date,
        dates.CurrentToDate
      )
      .query(`
        ;WITH Hotels AS
        (
          SELECT
            org.OrganizationID,
            org.ShortDisplayLabel AS Hotel

          FROM dbo.htl_tbl_organization_master AS org

          WHERE org.Activation_status = 1
            AND org.IsNileHotel = 1

            AND (
              @OrganizationID IS NULL
              OR org.OrganizationID = @OrganizationID
            )
        ),

        -- ====================================================
        -- ROOM REVENUE, OCCUPIED AND AVAILABLE
        -- ====================================================

        RoomData AS
        (
          SELECT
            a.OrganizationID,

            SUM(
              CASE
                WHEN im.Item = 'Net Room Revenue'
                THEN ISNULL(b.Amount, 0)
                ELSE 0
              END
            ) AS RoomRevenue,

            SUM(
              CASE
                WHEN im.Item = 'Rooms Occupied'
                 AND b.IsDelete = 0
                THEN ISNULL(b.Amount, 0)
                ELSE 0
              END
            ) AS RoomsOccupied,

            SUM(
              CASE
                WHEN im.Item = 'Rooms Available'
                 AND b.IsDelete = 0
                THEN ISNULL(b.Amount, 0)
                ELSE 0
              END
            ) AS RoomsAvailable

          FROM DailyRevenueReport.DailyRevenueReport_Tbl_Entry_Master AS a

          INNER JOIN DailyRevenueReport.DailyRevenueReport_Tbl_Entry_Room_Details AS b
            ON a.ID = b.EntryID

          INNER JOIN DailyRevenueReport.DailyRevenueReport_Tbl_Room_Item_Master AS im
            ON b.ItemID = im.ItemID

          WHERE a.IsDeleted = 0

            AND a.EntryDate >= @FromDate
            AND a.EntryDate < DATEADD(DAY, 1, @ToDate)

            AND im.Item IN (
              'Net Room Revenue',
              'Rooms Occupied',
              'Rooms Available'
            )

          GROUP BY a.OrganizationID
        )

        -- ====================================================
        -- FINAL ARR AND REVPAR
        -- ====================================================

        SELECT
          h.OrganizationID,
          h.Hotel,

          CAST(
            CASE
              WHEN ISNULL(r.RoomsOccupied, 0) > 0
              THEN r.RoomRevenue / r.RoomsOccupied
              ELSE 0
            END
            AS DECIMAL(12, 2)
          ) AS ARR,

          CAST(
            CASE
              WHEN ISNULL(r.RoomsAvailable, 0) > 0
              THEN r.RoomRevenue / r.RoomsAvailable
              ELSE 0
            END
            AS DECIMAL(12, 2)
          ) AS RevPar

        FROM Hotels AS h

        LEFT JOIN RoomData AS r
          ON h.OrganizationID = r.OrganizationID

        ORDER BY h.Hotel;
      `);

    // ========================================================
    // 6. Response Mapping
    // ========================================================

    const chartData = result.recordset.map((row) => ({
      OrganizationID:
        row.OrganizationID == null
          ? null
          : String(row.OrganizationID),

      Hotel: row.Hotel ?? null,

      ARR: Number(row.ARR ?? 0),
      Arrlabel: `${Math.round(Number(row.ARR ?? 0) / 1000)}k`,

      RevPar: Number(row.RevPar ?? 0),
      Revparlabel: `${Math.round(Number(row.RevPar ?? 0) / 1000)}k`,
    }));

    // ========================================================
    // 7. Response
    // ========================================================

    return ok(
      "CEO ARR and RevPAR chart fetched successfully.",
      chartData,
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalOrganizations: chartData.length,
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO ARR and RevPAR chart"
    );
  }
};
// 30. ============================================================ Out Of Order Trend
const getCEOOutOfOrderChart = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yesterday")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range (Existing Helper)
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 5. MSSQL Query
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .input(
        "FromDate",
        sql.Date,
        dates.CurrentFromDate
      )
      .input(
        "ToDate",
        sql.Date,
        dates.CurrentToDate
      )
      .query(`
        SELECT
          org.OrganizationID,

          dbo.FN_Get_OrganizationShortName(
            org.OrganizationID
          ) AS Hotel,

          ISNULL(ooo.Total, 0) AS Total

        FROM dbo.htl_tbl_organization_master AS org

        LEFT JOIN
        (
          SELECT
            a.OrganizationID,

            SUM(
              ISNULL(b.Amount, 0)
            ) AS Total

          FROM DailyRevenueReport.DailyRevenueReport_Tbl_Entry_Master AS a

          INNER JOIN DailyRevenueReport.DailyRevenueReport_Tbl_Entry_Room_Details AS b
            ON a.ID = b.EntryID

          INNER JOIN DailyRevenueReport.DailyRevenueReport_Tbl_Room_Item_Master AS i
            ON b.ItemID = i.ItemID

          WHERE i.Item = 'Out of Order'

            AND a.EntryDate >= @FromDate
            AND a.EntryDate < DATEADD(DAY, 1, @ToDate)

          GROUP BY a.OrganizationID

        ) AS ooo
          ON org.OrganizationID = ooo.OrganizationID

        WHERE org.Activation_status = 1
          AND org.IsNileHotel = 1

          AND (
            @OrganizationID IS NULL
            OR org.OrganizationID = @OrganizationID
          )

        ORDER BY Hotel;
      `);

    // ========================================================
    // 6. Response Mapping
    // ========================================================

    const chartData = result.recordset.map((row) => ({
      OrganizationID:
        row.OrganizationID == null
          ? null
          : String(row.OrganizationID),

      Hotel: row.Hotel ?? null,

      Total: Number(row.Total ?? 0),
    }));

    // ========================================================
    // 7. Overall Total
    // ========================================================

    const totalOutOfOrder = chartData.reduce(
      (sum, row) => sum + row.Total,
      0
    );

    // ========================================================
    // 8. Response
    // ========================================================

    return ok(
      "CEO out of order chart fetched successfully.",
      chartData,
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },

        TotalOrganizations: chartData.length,

        TotalOutOfOrder: totalOutOfOrder,
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO out of order chart"
    );
  }
};
// 31. ============================================================ Comp Rooms Count
const getCEOCompRoomsSummary = async (data) => {
  try {
    // ========================================================
    // 1. Filter Validation
    // ========================================================

    const filter = String(data.Filter || "yearly")
      .trim()
      .toLowerCase();

    if (
      !["yesterday", "weekly", "monthly", "yearly"]
        .includes(filter)
    ) {
      return fail(
        "Filter must be yesterday, weekly, monthly or yearly.",
        400
      );
    }

    // ========================================================
    // 2. OrganizationID Validation
    // ========================================================

    const rawOrganizationID = data.OrganizationID;

    const organizationID = rawOrganizationID == null
      ? ""
      : String(rawOrganizationID).trim();

    if (
      organizationID !== "" &&
      (
        (typeof rawOrganizationID !== "string" &&
          typeof rawOrganizationID !== "number") ||
        !/^[1-9]\d*$/.test(organizationID) ||
        BigInt(organizationID) > 9223372036854775807n
      )
    ) {
      return fail(
        "OrganizationID must be a positive integer.",
        400
      );
    }

    // ========================================================
    // 3. Date Range (Existing Helper)
    // ========================================================

    const dates = getDateRange(filter);

    // ========================================================
    // 4. MSSQL Connection
    // ========================================================

    const mssqlPool = await getMssqlPool();

    // ========================================================
    // 5. MSSQL Query - PMS VS HOTELOPS COMP ROOMS
    // ========================================================

    const result = await mssqlPool
      .request()
      .input(
        "OrganizationID",
        sql.BigInt,
        organizationID || null
      )
      .input(
        "FromDate",
        sql.Date,
        dates.CurrentFromDate
      )
      .input(
        "ToDate",
        sql.Date,
        dates.CurrentToDate
      )
      .query(`
        -- ====================================================
        -- PMS COMP ROOMS
        -- ====================================================

        ;WITH PMSData AS
        (
          SELECT
            m.OrganizationID,

            SUM(
              ISNULL(
                TRY_CONVERT(
                  DECIMAL(18, 2),
                  NULLIF(
                    REPLACE(r.FTD_Actual, ',', ''),
                    ''
                  )
                ),
                0
              )
            ) AS PMS

          FROM DailyRevenueReport.DailyRevenueReport_Tbl_Report_Entry_Master m

          INNER JOIN DailyRevenueReport.DailyRevenueReport_Tbl_Report_Room_Entry r
            ON m.EntryID = r.EntryID

          WHERE m.IsDeleted = 0

            AND (
              @OrganizationID IS NULL
              OR m.OrganizationID = @OrganizationID
            )

            AND m.EntryDate >= @FromDate
            AND m.EntryDate < DATEADD(DAY, 1, @ToDate)

            AND r.ItemID = 7

          GROUP BY m.OrganizationID
        ),

        -- ====================================================
        -- HOTELOPS COMP ROOMS
        -- ====================================================

        HotelOpsData AS
        (
          SELECT
            c.OrganizationID,

            COUNT(*) AS HotelOps

          FROM CompRoom.CompRoom_Tbl_Entry_Master c

          WHERE (
            @OrganizationID IS NULL
            OR c.OrganizationID = @OrganizationID
          )

            AND c.ArrivalDate < DATEADD(DAY, 1, @ToDate)
            AND c.DepartureDate > @FromDate

          GROUP BY c.OrganizationID
        ),

        -- ====================================================
        -- COMBINE PMS + HOTELOPS
        -- ====================================================

        CombinedData AS
        (
          SELECT
            COALESCE(
              p.OrganizationID,
              h.OrganizationID
            ) AS OrganizationID,

            ISNULL(p.PMS, 0) AS PMS,

            ISNULL(h.HotelOps, 0) AS HotelOps

          FROM PMSData p

          FULL OUTER JOIN HotelOpsData h
            ON p.OrganizationID = h.OrganizationID
        )

        -- ====================================================
        -- FINAL SUMMARY
        -- ====================================================

        SELECT
          CAST(
            ISNULL(SUM(PMS), 0)
            AS DECIMAL(18, 2)
          ) AS PMS,

          ISNULL(
            SUM(HotelOps),
            0
          ) AS HotelOps,

          CAST(
            ISNULL(SUM(HotelOps), 0)
            - ISNULL(SUM(PMS), 0)
            AS DECIMAL(18, 2)
          ) AS Variance

        FROM CombinedData;
      `);

    // ========================================================
    // 6. Response Mapping
    // ========================================================

    const row = result.recordset?.[0] || {};

    const summary = {
      PMS: Number(row.PMS ?? 0),

      HotelOps: Number(row.HotelOps ?? 0),

      Variance: Number(row.Variance ?? 0),
    };

    // ========================================================
    // 7. Response
    // ========================================================

    return ok(
      "CEO comp rooms summary fetched successfully.",
      summary,
      {
        Filter: filter,

        OrganizationID: organizationID || null,

        DateRange: {
          FromDate: dates.CurrentFromDate,
          ToDate: dates.CurrentToDate,
        },
      }
    );

  } catch (error) {
    return databaseFailure(
      error,
      "Fetch CEO comp rooms summary"
    );
  }
};






// ============================================================
// Exports
// ============================================================
module.exports = {
  getCEORevenueSummary,
  getCEORevenuePerformance,
  getCEOADRRevPARDetails,
  getCEOOutletRevenueDetails,
  getCEOBanquetRevenueDetails,
  getCEOTotalRevenueDetails,
  getCEORoomsRevenueDetails,
  getCEOFBRevenueDetails,
  getCEOOccupancy,
  getCEOGlitchAlerts,
  getCEOIncidentAlerts,
  getCEOExpiredAMCAlerts,
  getCEOHotelRevenueVsBudget,
  getCEODSRChart,
  getCEODSRVisitDetails,
  getCEOSRMSRequests,
  getCEOSRMSRequestDetails,
  getCEOTop20SRMSRequests,
  getCEOTop20SRMSRequestDetails,
  getCEOSRMSCompletionDuration,
  getCEOSRMSCompletionDurationDetails,
  getCEOGuestMetChart,
  getCEOGuestMetDetails,
  getCEOARCollection,
  getCEOARCollectionDetails,
  getCEOPayMasters,
  getCEOPayMastersDetails,
  getCEOForecastADR,
  getCEOPPMRooms,
  getCEOPPMChecklistDetails,
  getCEOTrainingHours,
  getCEOTrainingHoursDetails,
  getCEORestaurantFeedback,
  getCEORestaurantFeedbackDetails,
  getCEOConsumption,
  getCEOConsumptionDetails,
  getCEOCheckList,
  getCEODiscard,
  getCEODiscardDetails,
  getCEOLostAndFound,
  getCEOLostAndFoundDetails,
  getCEOOperationalHealth,
  getCEOOperationalGlitchDetails,
  getCEOOperationalIncidentDetails,
  getCEOForecastOccupancy,
  getCEOEngineeringSummary,
  getCEOEquipmentDetails,
  getCEOUnderWarrantyDetails,
  getCEOUnderAMCDetails,
  getCEOTotalBreakdownDetails,
  getCEOTotalMaintenanceDetails,
  getCEOPendingMaintenanceDetails,
  getCEOEngineeringMaintenanceChart,
  getCEOCompletedMaintenanceDetails,
  getCEOEngineeringBreakdownChart,
  getCEODailyBreakageChart,
  getCEODailyBreakageDetails,
  getCEOHLPReportChart,
  getCEOCateringSalesChart,
  getCEOCateringSalesDetails,
  getCEOSalesContractChart,
  getCEOSalesContractDetails,
  getCEOARRRevPARChart,
  getCEOOutOfOrderChart,
  getCEOCompRoomsSummary
};

