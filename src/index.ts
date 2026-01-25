#!/usr/bin/env node

/**
 * ESP32 DevOps MCP Server
 * AI-powered ESP32 development automation for Claude Code
 *
 * @author JosephR26
 * @license MIT
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Import tool modules
import * as serialTools from './tools/serial.js';
import * as buildTools from './tools/build.js';
import * as benchmarkTools from './tools/benchmark.js';
import * as testTools from './tools/test.js';

/**
 * MCP Server instance
 */
const server = new Server(
  {
    name: 'esp32-devops-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * Tool definitions
 */
const tools = [
  // Serial Port Management Tools
  {
    name: 'esp32_list_ports',
    description: 'List all available ESP32 serial ports with detection, favorites, and recommendations',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'esp32_detect_ports',
    description: 'Auto-detect ESP32 devices on serial ports',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'esp32_set_default_port',
    description: 'Set default serial port for ESP32 development',
    inputSchema: {
      type: 'object',
      properties: {
        port: {
          type: 'string',
          description: 'Serial port name (e.g., COM3, /dev/ttyUSB0)',
        },
      },
      required: ['port'],
    },
  },
  {
    name: 'esp32_add_favorite_port',
    description: 'Add a serial port to favorites with optional custom name',
    inputSchema: {
      type: 'object',
      properties: {
        port: {
          type: 'string',
          description: 'Serial port name',
        },
        name: {
          type: 'string',
          description: 'Custom name for this port (optional)',
        },
      },
      required: ['port'],
    },
  },
  {
    name: 'esp32_get_recommended_port',
    description: 'Get recommended serial port (default > last used > auto-detected)',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },

  // Build & Flash Tools
  {
    name: 'esp32_build',
    description: 'Build ESP32 firmware using PlatformIO with detailed output including memory usage',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to PlatformIO project (optional, uses current directory if not specified)',
        },
        environment: {
          type: 'string',
          description: 'PlatformIO environment name (optional, uses default if not specified)',
        },
      },
      required: [],
    },
  },
  {
    name: 'esp32_flash',
    description: 'Flash compiled firmware to ESP32 device',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to PlatformIO project (optional)',
        },
        port: {
          type: 'string',
          description: 'Serial port to flash to (optional, uses recommended port if not specified)',
        },
      },
      required: [],
    },
  },
  {
    name: 'esp32_full_cycle',
    description: 'Complete development cycle: build, flash, and monitor in one command',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to PlatformIO project (optional)',
        },
        port: {
          type: 'string',
          description: 'Serial port (optional)',
        },
      },
      required: [],
    },
  },
  {
    name: 'esp32_clean',
    description: 'Clean build artifacts and cache',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: {
          type: 'string',
          description: 'Path to PlatformIO project (optional)',
        },
      },
      required: [],
    },
  },

  // Performance & Benchmarking Tools
  {
    name: 'esp32_benchmark',
    description: 'Run comprehensive performance benchmark on ESP32 firmware (memory, loop timing, WiFi)',
    inputSchema: {
      type: 'object',
      properties: {
        port: {
          type: 'string',
          description: 'Serial port (optional)',
        },
        duration: {
          type: 'number',
          description: 'Benchmark duration in seconds (default: 60, max: 3600)',
          default: 60,
        },
        baudRate: {
          type: 'number',
          description: 'Baud rate (default: 115200)',
          default: 115200,
        },
      },
      required: [],
    },
  },
  {
    name: 'esp32_quick_benchmark',
    description: 'Quick 30-second performance check',
    inputSchema: {
      type: 'object',
      properties: {
        port: {
          type: 'string',
          description: 'Serial port (optional)',
        },
      },
      required: [],
    },
  },
  {
    name: 'esp32_detect_memory_leaks',
    description: 'Run extended test to detect memory leaks (5 minute default)',
    inputSchema: {
      type: 'object',
      properties: {
        port: {
          type: 'string',
          description: 'Serial port (optional)',
        },
        duration: {
          type: 'number',
          description: 'Test duration in seconds (default: 300)',
          default: 300,
        },
      },
      required: [],
    },
  },

  // Firmware Testing Tools
  {
    name: 'esp32_test_firmware',
    description: 'Run automated firmware tests (boot, heartbeat, memory stability)',
    inputSchema: {
      type: 'object',
      properties: {
        port: {
          type: 'string',
          description: 'Serial port (optional)',
        },
        baudRate: {
          type: 'number',
          description: 'Baud rate (default: 115200)',
          default: 115200,
        },
      },
      required: [],
    },
  },
  {
    name: 'esp32_validate_deployment',
    description: 'Pre-deployment validation - run all tests and report deployment readiness',
    inputSchema: {
      type: 'object',
      properties: {
        port: {
          type: 'string',
          description: 'Serial port (optional)',
        },
      },
      required: [],
    },
  },
];

/**
 * List available tools
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools,
  };
});

/**
 * Handle tool execution
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    // Serial Port Tools
    if (name === 'esp32_list_ports') {
      const result = await serialTools.listSerialPorts();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'esp32_detect_ports') {
      const result = await serialTools.detectESP32Ports();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'esp32_set_default_port') {
      const result = await serialTools.setDefaultPort(args.port as string);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'esp32_add_favorite_port') {
      const result = await serialTools.addFavoritePort(
        args.port as string,
        args.name as string | undefined
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'esp32_get_recommended_port') {
      const result = await serialTools.getRecommendedPort();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    // Build & Flash Tools
    if (name === 'esp32_build') {
      const result = await buildTools.buildFirmware(
        args.projectPath as string | undefined,
        args.environment as string | undefined
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'esp32_flash') {
      const result = await buildTools.flashFirmware(
        args.projectPath as string | undefined,
        args.port as string | undefined
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'esp32_full_cycle') {
      const result = await buildTools.fullCycle(
        args.projectPath as string | undefined,
        args.port as string | undefined
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'esp32_clean') {
      const result = await buildTools.cleanBuild(
        args.projectPath as string | undefined
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    // Benchmark Tools
    if (name === 'esp32_benchmark') {
      const result = await benchmarkTools.runBenchmark(
        args.port as string | undefined,
        args.duration as number | undefined,
        args.baudRate as number | undefined
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'esp32_quick_benchmark') {
      const result = await benchmarkTools.quickBenchmark(
        args.port as string | undefined
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'esp32_detect_memory_leaks') {
      const result = await benchmarkTools.detectMemoryLeaks(
        args.port as string | undefined,
        args.duration as number | undefined
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    // Testing Tools
    if (name === 'esp32_test_firmware') {
      const result = await testTools.runFirmwareTests(
        args.port as string | undefined,
        args.baudRate as number | undefined
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'esp32_validate_deployment') {
      const result = await testTools.validateForDeployment(
        args.port as string | undefined
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    // Unknown tool
    throw new Error(`Unknown tool: ${name}`);

  } catch (error: any) {
    return {
      content: [
        {
            type: 'text',
          text: JSON.stringify({
            success: false,
            error: error.message,
          }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

/**
 * Start the server
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('ESP32 DevOps MCP Server started');
  console.error('Version: 1.0.0');
  console.error('Toolkit path:', process.env.FIRMWARE_TOOLKIT_PATH || '[NOT SET - required for benchmarking/testing features]');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
