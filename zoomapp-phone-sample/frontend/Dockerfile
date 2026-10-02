# Frontend Dockerfile with hot reload support
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code (volumes will override this in development)
COPY . .

# Expose port
EXPOSE 3000

# Start Vite development server
CMD ["npm", "run", "dev"]
