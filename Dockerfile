FROM node:20-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000
ENV SQLITE_PATH=/app/data/parking_history.db

EXPOSE 3000

CMD ["npm", "run", "start:docker"]
