-- legacy / prod: no database named; one table with no schema either.
CREATE TABLE sales.orders (order_no INT, cust_no INT, order_date DATE);
CREATE TABLE orders (id INT, total DECIMAL(10,2));
