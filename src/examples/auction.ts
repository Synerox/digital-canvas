/**
 * Demo design bundled with the app: a two-player sealed-bid auction.
 * It is small, but exercises buses, slices, constants, fan-out,
 * comparators, adders, MUXes and a `1 << x` decoder.
 */
export const AUCTION_FILE = 'auction.v';

export const AUCTION_SOURCE = `// Digital Canvas demo: two-player sealed-bid auction
module bid_check (
  input  [3:0] bid,
  input  [3:0] budget,
  output       valid
);
  assign valid = (bid != 4'd0) && (bid <= budget);
endmodule

module max_select (
  input  [3:0] bid_a,
  input  [3:0] bid_b,
  input        valid_a,
  input        valid_b,
  output [3:0] max_bid,
  output       winner
);
  wire [3:0] a_eff = valid_a ? bid_a : 4'd0;
  wire [3:0] b_eff = valid_b ? bid_b : 4'd0;
  assign winner  = b_eff > a_eff;
  assign max_bid = winner ? b_eff : a_eff;
endmodule

module score_calc (
  input  [3:0] max_bid,
  input  [1:0] bonus,
  output [5:0] score
);
  // bonus counts four points each
  assign score = {2'b00, max_bid} + {bonus, 2'b00};
endmodule

module result_decode (
  input        winner,
  input        any_valid,
  output [1:0] onehot
);
  assign onehot = any_valid ? (2'd1 << winner) : 2'd0;
endmodule

module score_board (
  input        clk,
  input        rst,
  input  [1:0] onehot,
  output reg [2:0] wins_a,
  output reg [2:0] wins_b
);
  always @(posedge clk) begin
    if (rst) begin
      wins_a <= 3'd0;
      wins_b <= 3'd0;
    end else begin
      wins_a <= wins_a + onehot[0];
      wins_b <= wins_b + onehot[1];
    end
  end
endmodule

module auction_top (
  input        clk,
  input        rst,
  input  [3:0] bid_a,
  input  [3:0] bid_b,
  input  [3:0] budget,
  input  [1:0] bonus,
  output [5:0] score,
  output [1:0] winner_onehot,
  output [2:0] wins_a,
  output [2:0] wins_b
);
  wire       valid_a, valid_b, winner;
  wire [3:0] max_bid;

  bid_check     u_check_a (.bid(bid_a), .budget(budget), .valid(valid_a));
  bid_check     u_check_b (.bid(bid_b), .budget(budget), .valid(valid_b));
  max_select    u_max     (.bid_a(bid_a), .bid_b(bid_b),
                           .valid_a(valid_a), .valid_b(valid_b),
                           .max_bid(max_bid), .winner(winner));
  score_calc    u_score   (.max_bid(max_bid), .bonus(bonus), .score(score));
  result_decode u_result  (.winner(winner), .any_valid(valid_a | valid_b),
                           .onehot(winner_onehot));
  score_board   u_board   (.clk(clk), .rst(rst), .onehot(winner_onehot),
                           .wins_a(wins_a), .wins_b(wins_b));
endmodule
`;
