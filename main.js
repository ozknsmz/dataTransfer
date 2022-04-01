/* eslint no-unused-expressions: 0 */
/*
 *  Copyright (c) 2015 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */
"use strict";

let localConnection;
let remoteConnection;
let sendChannel;
let receiveChannel;
let fileReader;
const bitrateDiv = document.querySelector("div#bitrate");
const fileInput = document.querySelector("input#fileInput");
const abortButton = document.querySelector("button#abortButton");
const downloadAnchor = document.querySelector("a#download");
const sendProgress = document.querySelector("progress#sendProgress");
const receiveProgress = document.querySelector("progress#receiveProgress");
const statusMessage = document.querySelector("span#status");
const sendFileButton = document.querySelector("button#sendFile");

let receiveBuffer = [];
let receivedSize = 0;
let fileSizeInfoReceived;
let fileNameRecieved;

let bytesPrev = 0;
let timestampPrev = 0;
let timestampStart;
let statsInterval = null;
let bitrateMax = 0;

const signaling = new BroadcastChannel("webrtc");
signaling.onmessage = (e) => {
  switch (e.data.type) {
    case "offer":
      createAnswer(e.data);
      break;
    case "answer":
      connect(e.data);
      break;
    case "candidate":
      handleCandidate(e.data);
      break;
    case "file":
      console.log(e.data);
      fileSizeInfoReceived = e.data.data.size;
      fileNameRecieved = e.data.data.name;
    default:
      console.log("unhandled", e);
      break;
  }
};

sendFileButton.addEventListener("click", () => createConnection());

fileInput.addEventListener("change", handleFileInputChange, false);

abortButton.addEventListener("click", () => {
  if (fileReader && fileReader.readyState === 1) {
    console.log("Abort read!");
    fileReader.abort();
  }
});

async function handleFileInputChange() {
  const file = fileInput.files[0];
  if (!file) {
    console.log("No file chosen");
  } else {
    sendFileButton.disabled = false;
  }
}

/**
 * create peer connection for L
 */
async function createConnection() {
  console.log(fileInput.files);
  abortButton.disabled = false;
  sendFileButton.disabled = true;
  localConnection = new RTCPeerConnection();
  console.log("Created local peer connection object localConnection");

  sendChannel = localConnection.createDataChannel("sendDataChannel");
  sendChannel.binaryType = "arraybuffer";
  console.log("Created send data channel");

  sendChannel.addEventListener("open", onSendChannelStateChange);
  console.log("Connection OPENED!");
  sendChannel.addEventListener("close", onSendChannelStateChange);
  sendChannel.addEventListener("error", onError);

  // localConnection.addEventListener("icecandidate", async (event) => {
  //   console.log("Local ICE candidate: ", event.candidate);
  //   await remoteConnection.addIceCandidate(event.candidate);
  // });

  localConnection.onicecandidate = (e) => {
    console.log("Created offer");
  };

  localConnection
    .createOffer()
    .then(async (offer) => {
      return localConnection.setLocalDescription(offer);
    })
    .then(function () {
      return new Promise(function (resolve) {
        if (localConnection.iceGatheringState === "complete") {
          resolve();
        } else {
          function checkState() {
            if (localConnection.iceGatheringState === "complete") {
              localConnection.removeEventListener(
                "icegatheringstatechange",
                checkState
              );
              resolve();
            }
          }
          localConnection.addEventListener(
            "icegatheringstatechange",
            checkState
          );
        }
      });
    })
    .then(function () {
      var offer = localConnection.localDescription;
      signaling.postMessage({ type: "offer", sdp: offer.sdp });
    });

  fileInput.disabled = true;
}

async function createAnswer(offer) {
  remoteConnection = new RTCPeerConnection();
  remoteConnection.onicecandidate = (e) => {
    console.log("created offered");
  };
  console.log("Created remote peer connection object remoteConnection");
  // remoteConnection.addEventListener("icecandidate", async (event) => {
  //   console.log("Remote ICE candidate: ", event.candidate);
  //   await localConnection.addIceCandidate(event.candidate);
  // });
  remoteConnection.addEventListener("datachannel", receiveChannelCallback);
  await remoteConnection.setRemoteDescription(offer);

  await remoteConnection
    .createAnswer()
    .then(async (answer) => {
      console.log(answer);
      await remoteConnection.setLocalDescription(answer);
      console.log(remoteConnection.setLocalDescription);
      signaling.postMessage({ type: "answer", sdp: answer.sdp });
    })
    .then((answer) => {
      console.log("answer created!");
    });
}

function receiveChannelCallback(event) {
  console.log("Receive Channel Callback");
  receiveChannel = event.channel;
  receiveChannel.binaryType = "arraybuffer";
  receiveChannel.onmessage = onReceiveMessageCallback;
  receiveChannel.onopen = onReceiveChannelStateChange;
  receiveChannel.onclose = onReceiveChannelStateChange;
  console.log("Connection OPENED!");

  receivedSize = 0;
  bitrateMax = 0;
  downloadAnchor.textContent = "";
  downloadAnchor.removeAttribute("download");
  console.log(downloadAnchor.href);
  if (downloadAnchor.href) {
    URL.revokeObjectURL(downloadAnchor.href);
    downloadAnchor.removeAttribute("href");
  }
}

async function connect(e) {
  await localConnection.setRemoteDescription({ type: "answer", sdp: e.sdp });
}

function sendData() {
  const file = fileInput.files[0];
  signaling.postMessage({
    type: "file",
    data: { size: file.size, name: file.name },
  });

  console.log(
    `File is ${[file.name, file.size, file.type, file.lastModified].join(" ")}`
  );

  // Handle 0 size files.
  statusMessage.textContent = "";
  downloadAnchor.textContent = "";
  if (file.size === 0) {
    createAnswer;
    bitrateDiv.innerHTML = "";
    statusMessage.textContent = "File is empty, please select a non-empty file";
    closeDataChannels();
    return;
  }
  sendProgress.max = file.size;
  receiveProgress.max = file.size;
  const chunkSize = 16384;
  fileReader = new FileReader();
  let offset = 0;
  fileReader.addEventListener("error", (error) =>
    console.error("Error reading file:", error)
  );
  fileReader.addEventListener("abort", (event) =>
    console.log("File reading aborted:", event)
  );
  fileReader.addEventListener("load", (e) => {
    console.log("FileRead.onload ", e);
    sendChannel.send(e.target.result);
    offset += e.target.result.byteLength;
    sendProgress.value = offset;
    if (offset < file.size) {
      readSlice(offset);
    }
  });
  const readSlice = (o) => {
    console.log("readSlice ", o);
    const slice = file.slice(offset, o + chunkSize);
    fileReader.readAsArrayBuffer(slice);
  };
  readSlice(0);
}

// function closeDataChannels() {
//   console.log("Closing data channels");
//   sendChannel.close();
//   console.log(`Closed data channel with label: ${sendChannel.label}`);
//   sendChannel = null;
//   if (receiveChannel) {
//     receiveChannel.close();
//     console.log(`Closed data channel with label: ${receiveChannel.label}`);
//     receiveChannel = null;
//   }
//   localConnection.close();
//   remoteConnection.close();
//   localConnection = null;
//   remoteConnection = null;
//   console.log("Closed peer connections");

//   // re-enable the file select
//   fileInput.disabled = false;
//   abortButton.disabled = true;
//   sendFileButton.disabled = false;
// }

async function gotLocalDescription(desc) {
  await localConnection.setLocalDescription(desc);
}

async function gotRemoteDescription(desc) {
  await remoteConnection.setLocalDescription(desc);
  console.log(`Answer from remoteConnection\n ${desc.sdp}`);
  await localConnection.setRemoteDescription(desc);
}

function onReceiveMessageCallback(event) {
  console.log(`Received Message ${event.data.byteLength}`);
  receiveBuffer.push(event.data);
  receivedSize += event.data.byteLength;
  receiveProgress.value = receivedSize;

  // we are assuming that our signaling protocol told
  // about the expected file size (and name, hash, etc).
  //const file = fileInput.files[0];
  console.log(receivedSize);
  console.log(fileSizeInfoReceived);

  if (receivedSize === fileSizeInfoReceived) {
    console.log("here");
    const received = new Blob(receiveBuffer);
    receiveBuffer = [];

    downloadAnchor.href = URL.createObjectURL(received);
    downloadAnchor.download = fileSizeInfoReceived;
    downloadAnchor.textContent = `Click to download '${fileNameRecieved}' (${fileSizeInfoReceived} bytes)`;
    downloadAnchor.style.display = "block";

    const bitrate = Math.round(
      (receivedSize * 8) / (new Date().getTime() - timestampStart)
    );
    bitrateDiv.innerHTML = `<strong>Average Bitrate:</strong> ${bitrate} kbits/sec (max: ${bitrateMax} kbits/sec)`;

    if (statsInterval) {
      clearInterval(statsInterval);
      statsInterval = null;
    }

    closeDataChannels();
  }
}

function onSendChannelStateChange() {
  if (sendChannel) {
    const { readyState } = sendChannel;
    console.log(`Send channel state is: ${readyState}`);
    if (readyState === "open") {
      sendData();
    }
  }
}

function onError(error) {
  if (sendChannel) {
    console.error("Error in sendChannel:", error);
    return;
  }
  console.log("Error in sendChannel which is already closed:", error);
}

async function onReceiveChannelStateChange() {
  if (receiveChannel) {
    const readyState = receiveChannel.readyState;
    console.log(`Receive channel state is: ${readyState}`);
    if (readyState === "open") {
      timestampStart = new Date().getTime();
      timestampPrev = timestampStart;
      statsInterval = setInterval(displayStats, 500);
      await displayStats();
    }
  }
}

// display bitrate statistics.
async function displayStats() {
  if (remoteConnection && remoteConnection.iceConnectionState === "connected") {
    const stats = await remoteConnection.getStats();
    let activeCandidatePair;
    stats.forEach((report) => {
      if (report.type === "transport") {
        activeCandidatePair = stats.get(report.selectedCandidatePairId);
      }
    });
    if (activeCandidatePair) {
      if (timestampPrev === activeCandidatePair.timestamp) {
        return;
      }
      // calculate current bitrate
      const bytesNow = activeCandidatePair.bytesReceived;
      const bitrate = Math.round(
        ((bytesNow - bytesPrev) * 8) /
          (activeCandidatePair.timestamp - timestampPrev)
      );
      bitrateDiv.innerHTML = `<strong>Current Bitrate:</strong> ${bitrate} kbits/sec`;
      timestampPrev = activeCandidatePair.timestamp;
      bytesPrev = bytesNow;
      if (bitrate > bitrateMax) {
        bitrateMax = bitrate;
      }
    }
  }
}
