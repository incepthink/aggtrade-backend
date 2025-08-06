import type { Request, Response, NextFunction } from "express";
import axios from "axios";

const ONEINCH_BASE_URL = "https://api.1inch.dev";

export const getTokens1inch = async (req: Request, res: Response) => {
  try {
    const { chainId = "1" } = req.query; // Default to Ethereum mainnet

    const response = await fetch(
      `https://api.1inch.dev/token/v1.2/${chainId}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.ONEINCH_KEY}`,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`1inch API error: ${response.status}`);
    }

    const data = await response.json();

    //  the tokens data
    res.status(200).json(data);
  } catch (error) {
    console.error("Tokens API error:", error);
    res.status(500).json({ error: "Failed to fetch tokens" });
  }
};

export const portfolioDetailedController = async (
  req: Request,
  res: Response
) => {
  try {
    const { addresses } = req.query;

    // Validate addresses parameter
    if (!addresses) {
      res.status(400).json({
        error: "addresses parameter is required",
      });
    }

    // Validate API key
    if (!process.env.ONEINCH_KEY) {
      console.error("1inch API key not configured");
      res.status(500).json({
        error: "1inch API key not configured",
      });
    }

    // Make request to 1inch API
    const response = await axios.get(
      `${ONEINCH_BASE_URL}/portfolio/portfolio/v4/overview/erc20/details`,
      {
        params: {
          addresses: addresses,
        },
        headers: {
          Authorization: `Bearer ${process.env.ONEINCH_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 10000, // 10 second timeout
      }
    );

    //  successful response
    res.status(200).json(response.data);
  } catch (error: any) {
    console.error("Portfolio detailed API error:", error);

    // Handle different types of errors
    if (error.response) {
      // 1inch API ed an error response
      const status = error.response.status;
      const message =
        error.response.data?.message || `1inch API error: ${status}`;

      res.status(status).json({
        error: message,
        details: error.response.data,
      });
    } else if (error.request) {
      // Network error - no response received
      res.status(503).json({
        error: "Failed to connect to 1inch API",
        details: "Service temporarily unavailable",
      });
    } else {
      // Other error (validation, parsing, etc.)
      res.status(500).json({
        error: "Failed to fetch detailed portfolio",
        details: error.message,
      });
    }
  }
};

export const portfolioHistoryController = async (
  req: Request,
  res: Response
) => {
  try {
    const { addresses, start, end } = req.query;

    // Validate required parameters
    if (!addresses || !start || !end) {
      res.status(400).json({
        error: "addresses, start, and end parameters are required",
      });
    }

    // Validate API key
    if (!process.env.ONEINCH_KEY) {
      console.error("1inch API key not configured");
      res.status(500).json({
        error: "1inch API key not configured",
      });
    }

    // Make request to 1inch API
    const response = await axios.get(
      `${ONEINCH_BASE_URL}/portfolio/portfolio/v4/general/value_chart`,
      {
        params: {
          addresses: addresses,
          timerange: "1week",
          chain_id: 1,
        },
        headers: {
          Authorization: `Bearer ${process.env.ONEINCH_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 10000, // 10 second timeout
      }
    );

    //  successful response
    res.status(200).json(response.data);
  } catch (error: any) {
    console.error("Portfolio history API error:", error);

    // Handle different types of errors
    if (error.response) {
      // 1inch API ed an error response
      const status = error.response.status;
      const message =
        error.response.data?.message || `1inch API error: ${status}`;

      res.status(status).json({
        error: message,
        details: error.response.data,
      });
    } else if (error.request) {
      // Network error - no response received
      res.status(503).json({
        error: "Failed to connect to 1inch API",
        details: "Service temporarily unavailable",
      });
    } else {
      // Other error (validation, parsing, etc.)
      res.status(500).json({
        error: "Failed to fetch portfolio history",
        details: error.message,
      });
    }
  }
};
