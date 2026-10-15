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
            AND EntryDate >= @BusinessDate
            AND EntryDate < DATEADD(
              DAY, 1, @BusinessDate
            )
        )

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
          YTD_Variance

        FROM LatestRevenue

        WHERE RowNo = 1

        ORDER BY OrganizationID ASC;
      `);

    // ========================================================
    // 4. Response Mapping
    // ========================================================

    const hotels = result.recordset.map((row, index) => ({
      SrNo: index + 1,

      OrganizationID: Number(row.OrganizationID),

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




// ============================================================
// Exports
// ============================================================
module.exports = {
  getCEORevenueSummary,
  getCEOOccupancy,
  getCEOGlitchAlerts,
  getCEOIncidentAlerts,
  getCEOExpiredAMCAlerts,
  getCEOHotelRevenueVsBudget,
};

