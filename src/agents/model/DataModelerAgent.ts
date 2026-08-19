import { AgentExecutionContext, AgentExecutionResult, PlanStep, GeneratedArtifact } from '../../core/types';

/**
 * Data Modeler Agent
 *
 * Generates dimensional (star/snowflake), Data Vault, or OBT data models
 * based on the target environment configuration and source schema context.
 */
export async function executeDataModelerAgent(
  step: PlanStep,
  context: AgentExecutionContext
): Promise<AgentExecutionResult> {
  const target = context.targetEnvironment;
  const pc = target?.platformConfig as unknown as Record<string, string> | undefined;
  const approach = target?.modelingApproach || 'dimensional';
  const namingConvention = target?.namingConvention || 'snake_case';
  const targetDb = pc?.['database'] || 'CURATED_DB';
  const targetSchema = pc?.['schema'] || 'ANALYTICS';

  context.log(`Data Modeler agent generating ${approach} model for ${targetDb}.${targetSchema}...`);

  let ddl = '';
  let modelDescription = '';

  switch (approach) {
    case 'dimensional':
      ({ ddl, modelDescription } = generateDimensionalModel(targetDb, targetSchema, namingConvention));
      break;
    case 'data-vault':
      ({ ddl, modelDescription } = generateDataVaultModel(targetDb, targetSchema, namingConvention));
      break;
    case 'obt':
      ({ ddl, modelDescription } = generateObtModel(targetDb, targetSchema, namingConvention));
      break;
    case '3nf':
      ({ ddl, modelDescription } = generate3nfModel(targetDb, targetSchema, namingConvention));
      break;
    default:
      ({ ddl, modelDescription } = generateDimensionalModel(targetDb, targetSchema, namingConvention));
  }

  const artifact: GeneratedArtifact = {
    id: `model-${step.id}-${Date.now()}`,
    type: 'data_model',
    title: `${capitalize(approach)} Model: ${targetDb}.${targetSchema}`,
    description: modelDescription,
    content: ddl,
    language: 'sql',
    generatedBy: 'dataModelerAgent',
    generatedAt: new Date().toISOString(),
    approved: false
  };

  if (context.addArtifact) {
    context.addArtifact(artifact);
  }

  return {
    success: true,
    message: `Data Modeler generated ${approach} model for ${targetDb}.${targetSchema} with ${namingConvention} naming.`,
    details: {
      approach,
      targetDb,
      targetSchema,
      namingConvention,
      ddl
    },
    artifacts: [artifact]
  };
}

// ── Model Generators ──

function generateDimensionalModel(db: string, schema: string, naming: string): { ddl: string; modelDescription: string } {
  const dimCustomer = applyNaming('dim_customer', naming);
  const dimDate = applyNaming('dim_date', naming);
  const dimProduct = applyNaming('dim_product', naming);
  const factSales = applyNaming('fact_sales', naming);

  const ddl = `-- Dimensional Model (Star Schema)
-- Generated for ${db}.${schema}

-- Dimension: Customer
CREATE OR REPLACE TABLE ${db}.${schema}.${dimCustomer} (
    ${applyNaming('customer_key', naming)} INTEGER PRIMARY KEY,
    ${applyNaming('customer_id', naming)} STRING NOT NULL,
    ${applyNaming('customer_name', naming)} STRING,
    ${applyNaming('email', naming)} STRING,
    ${applyNaming('region', naming)} STRING,
    ${applyNaming('segment', naming)} STRING,
    ${applyNaming('created_at', naming)} TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    ${applyNaming('updated_at', naming)} TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

-- Dimension: Date
CREATE OR REPLACE TABLE ${db}.${schema}.${dimDate} (
    ${applyNaming('date_key', naming)} INTEGER PRIMARY KEY,
    ${applyNaming('full_date', naming)} DATE NOT NULL,
    ${applyNaming('year', naming)} INTEGER,
    ${applyNaming('quarter', naming)} INTEGER,
    ${applyNaming('month', naming)} INTEGER,
    ${applyNaming('day', naming)} INTEGER,
    ${applyNaming('day_of_week', naming)} STRING,
    ${applyNaming('is_holiday', naming)} BOOLEAN DEFAULT FALSE
);

-- Dimension: Product
CREATE OR REPLACE TABLE ${db}.${schema}.${dimProduct} (
    ${applyNaming('product_key', naming)} INTEGER PRIMARY KEY,
    ${applyNaming('product_id', naming)} STRING NOT NULL,
    ${applyNaming('product_name', naming)} STRING,
    ${applyNaming('category', naming)} STRING,
    ${applyNaming('subcategory', naming)} STRING,
    ${applyNaming('unit_price', naming)} DECIMAL(10,2),
    ${applyNaming('created_at', naming)} TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

-- Fact: Sales
CREATE OR REPLACE TABLE ${db}.${schema}.${factSales} (
    ${applyNaming('sales_key', naming)} INTEGER PRIMARY KEY,
    ${applyNaming('customer_key', naming)} INTEGER REFERENCES ${db}.${schema}.${dimCustomer}(${applyNaming('customer_key', naming)}),
    ${applyNaming('date_key', naming)} INTEGER REFERENCES ${db}.${schema}.${dimDate}(${applyNaming('date_key', naming)}),
    ${applyNaming('product_key', naming)} INTEGER REFERENCES ${db}.${schema}.${dimProduct}(${applyNaming('product_key', naming)}),
    ${applyNaming('quantity', naming)} INTEGER,
    ${applyNaming('unit_price', naming)} DECIMAL(10,2),
    ${applyNaming('total_amount', naming)} DECIMAL(12,2),
    ${applyNaming('discount_amount', naming)} DECIMAL(10,2),
    ${applyNaming('transaction_date', naming)} DATE,
    ${applyNaming('created_at', naming)} TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);`;

  return {
    ddl,
    modelDescription: `Star schema with 3 dimensions (Customer, Date, Product) and 1 fact table (Sales) in ${db}.${schema}`
  };
}

function generateDataVaultModel(db: string, schema: string, naming: string): { ddl: string; modelDescription: string } {
  const hubCustomer = applyNaming('hub_customer', naming);
  const hubProduct = applyNaming('hub_product', naming);
  const linkSales = applyNaming('lnk_sales_transaction', naming);
  const satCustomer = applyNaming('sat_customer_details', naming);
  const satSales = applyNaming('sat_sales_details', naming);

  const ddl = `-- Data Vault 2.0 Model
-- Generated for ${db}.${schema}

-- Hub: Customer
CREATE OR REPLACE TABLE ${db}.${schema}.${hubCustomer} (
    ${applyNaming('customer_hash_key', naming)} STRING PRIMARY KEY,
    ${applyNaming('customer_id', naming)} STRING NOT NULL,
    ${applyNaming('load_date', naming)} TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    ${applyNaming('record_source', naming)} STRING
);

-- Hub: Product
CREATE OR REPLACE TABLE ${db}.${schema}.${hubProduct} (
    ${applyNaming('product_hash_key', naming)} STRING PRIMARY KEY,
    ${applyNaming('product_id', naming)} STRING NOT NULL,
    ${applyNaming('load_date', naming)} TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    ${applyNaming('record_source', naming)} STRING
);

-- Link: Sales Transaction
CREATE OR REPLACE TABLE ${db}.${schema}.${linkSales} (
    ${applyNaming('sales_hash_key', naming)} STRING PRIMARY KEY,
    ${applyNaming('customer_hash_key', naming)} STRING REFERENCES ${db}.${schema}.${hubCustomer}(${applyNaming('customer_hash_key', naming)}),
    ${applyNaming('product_hash_key', naming)} STRING REFERENCES ${db}.${schema}.${hubProduct}(${applyNaming('product_hash_key', naming)}),
    ${applyNaming('transaction_id', naming)} STRING NOT NULL,
    ${applyNaming('load_date', naming)} TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    ${applyNaming('record_source', naming)} STRING
);

-- Satellite: Customer Details
CREATE OR REPLACE TABLE ${db}.${schema}.${satCustomer} (
    ${applyNaming('customer_hash_key', naming)} STRING REFERENCES ${db}.${schema}.${hubCustomer}(${applyNaming('customer_hash_key', naming)}),
    ${applyNaming('load_date', naming)} TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    ${applyNaming('customer_name', naming)} STRING,
    ${applyNaming('email', naming)} STRING,
    ${applyNaming('region', naming)} STRING,
    ${applyNaming('segment', naming)} STRING,
    ${applyNaming('record_source', naming)} STRING,
    PRIMARY KEY (${applyNaming('customer_hash_key', naming)}, ${applyNaming('load_date', naming)})
);

-- Satellite: Sales Details
CREATE OR REPLACE TABLE ${db}.${schema}.${satSales} (
    ${applyNaming('sales_hash_key', naming)} STRING REFERENCES ${db}.${schema}.${linkSales}(${applyNaming('sales_hash_key', naming)}),
    ${applyNaming('load_date', naming)} TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
    ${applyNaming('quantity', naming)} INTEGER,
    ${applyNaming('unit_price', naming)} DECIMAL(10,2),
    ${applyNaming('total_amount', naming)} DECIMAL(12,2),
    ${applyNaming('discount_amount', naming)} DECIMAL(10,2),
    ${applyNaming('record_source', naming)} STRING,
    PRIMARY KEY (${applyNaming('sales_hash_key', naming)}, ${applyNaming('load_date', naming)})
);`;

  return {
    ddl,
    modelDescription: `Data Vault 2.0 model with 2 hubs (Customer, Product), 1 link (Sales Transaction), and 2 satellites in ${db}.${schema}`
  };
}

function generateObtModel(db: string, schema: string, naming: string): { ddl: string; modelDescription: string } {
  const wideTable = applyNaming('analytics_sales_wide', naming);

  const ddl = `-- One Big Table (OBT) Model
-- Generated for ${db}.${schema}

CREATE OR REPLACE TABLE ${db}.${schema}.${wideTable} (
    ${applyNaming('transaction_id', naming)} STRING PRIMARY KEY,
    ${applyNaming('transaction_date', naming)} DATE,
    -- Customer attributes
    ${applyNaming('customer_id', naming)} STRING,
    ${applyNaming('customer_name', naming)} STRING,
    ${applyNaming('customer_region', naming)} STRING,
    ${applyNaming('customer_segment', naming)} STRING,
    -- Product attributes
    ${applyNaming('product_id', naming)} STRING,
    ${applyNaming('product_name', naming)} STRING,
    ${applyNaming('product_category', naming)} STRING,
    -- Sales metrics
    ${applyNaming('quantity', naming)} INTEGER,
    ${applyNaming('unit_price', naming)} DECIMAL(10,2),
    ${applyNaming('total_amount', naming)} DECIMAL(12,2),
    ${applyNaming('discount_amount', naming)} DECIMAL(10,2),
    -- Metadata
    ${applyNaming('created_at', naming)} TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);`;

  return {
    ddl,
    modelDescription: `One Big Table (OBT) with denormalized customer, product, and sales attributes in ${db}.${schema}`
  };
}

function generate3nfModel(db: string, schema: string, naming: string): { ddl: string; modelDescription: string } {
  const customers = applyNaming('customers', naming);
  const products = applyNaming('products', naming);
  const orders = applyNaming('orders', naming);
  const orderItems = applyNaming('order_items', naming);

  const ddl = `-- Third Normal Form (3NF) Model
-- Generated for ${db}.${schema}

CREATE OR REPLACE TABLE ${db}.${schema}.${customers} (
    ${applyNaming('customer_id', naming)} STRING PRIMARY KEY,
    ${applyNaming('name', naming)} STRING NOT NULL,
    ${applyNaming('email', naming)} STRING UNIQUE,
    ${applyNaming('region', naming)} STRING,
    ${applyNaming('created_at', naming)} TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

CREATE OR REPLACE TABLE ${db}.${schema}.${products} (
    ${applyNaming('product_id', naming)} STRING PRIMARY KEY,
    ${applyNaming('name', naming)} STRING NOT NULL,
    ${applyNaming('category', naming)} STRING,
    ${applyNaming('unit_price', naming)} DECIMAL(10,2),
    ${applyNaming('created_at', naming)} TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

CREATE OR REPLACE TABLE ${db}.${schema}.${orders} (
    ${applyNaming('order_id', naming)} STRING PRIMARY KEY,
    ${applyNaming('customer_id', naming)} STRING REFERENCES ${db}.${schema}.${customers}(${applyNaming('customer_id', naming)}),
    ${applyNaming('order_date', naming)} DATE NOT NULL,
    ${applyNaming('status', naming)} STRING,
    ${applyNaming('total_amount', naming)} DECIMAL(12,2),
    ${applyNaming('created_at', naming)} TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

CREATE OR REPLACE TABLE ${db}.${schema}.${orderItems} (
    ${applyNaming('order_item_id', naming)} STRING PRIMARY KEY,
    ${applyNaming('order_id', naming)} STRING REFERENCES ${db}.${schema}.${orders}(${applyNaming('order_id', naming)}),
    ${applyNaming('product_id', naming)} STRING REFERENCES ${db}.${schema}.${products}(${applyNaming('product_id', naming)}),
    ${applyNaming('quantity', naming)} INTEGER,
    ${applyNaming('unit_price', naming)} DECIMAL(10,2),
    ${applyNaming('line_total', naming)} DECIMAL(12,2)
);`;

  return {
    ddl,
    modelDescription: `3NF model with 4 normalized tables (Customers, Products, Orders, Order Items) in ${db}.${schema}`
  };
}

// ── Helpers ──

function applyNaming(name: string, convention: string): string {
  switch (convention) {
    case 'camelCase':
      return name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    case 'PascalCase':
      return name.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase());
    case 'snake_case':
    default:
      return name;
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}